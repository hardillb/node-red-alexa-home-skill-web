///////////////////////////////////////////////////////////////////////////
// Depends
///////////////////////////////////////////////////////////////////////////
const axios = require('axios');
const querystring = require('querystring');
var logger = require('../loaders/logger');
var AlexaAuth = require('../models/alexa-auth');
///////////////////////////////////////////////////////////////////////////
// Variables
///////////////////////////////////////////////////////////////////////////
//var debug = (process.env.ALEXA_DEBUG || false);
var enableAlexaAuthorization = false;
if (!process.env.ALEXA_CLIENTID && !process.env.ALEXA_CLIENTSECRET) {
    logger.log('warn', "[AlexaAuth] ALEXA_CLIENTID and ALEXA_CLIENTSECRET environment variables undefined, state reporting disabled!");
}
else {
    var client_id = process.env.ALEXA_CLIENTID;
    var client_secret = process.env.ALEXA_CLIENTSECRET;
    enableAlexaAuthorization = true;
}
///////////////////////////////////////////////////////////////////////////
// Exports
///////////////////////////////////////////////////////////////////////////

// Save/ return valid Grant Code
const saveGrantAsync = async(user, grantCode) => {
	try {
        // Delete existing grant/ refresh/ access tokens for given user
        await AlexaAuth.AlexaAuthGrantCode.deleteMany({user: user});
        await AlexaAuth.AlexaAuthRefreshToken.deleteMany({user: user});
        await AlexaAuth.AlexaAuthAccessToken.deleteMany({user: user});
        // Store new Grant Code for user
        var newGrant = new AlexaAuth.AlexaAuthGrantCode({
            user: user,
            code: grantCode
        });
        // Save Grant Code
        await newGrant.save();
        // Test Grant Code by requesting an Access Token for user
        var accessToken = await requestAccessTokenAsync(user);
        // Success, return Grant Code
        if (accessToken != undefined){
            return newGrant;
        }
        // Failure, return undefined
        else {
            return undefined;
        }
    }
    catch(e) {
        // Failure, return undefined
        logger.log('error', "[AlexaAuth] Grant Code save/ store/ test failed for user: " + user.username + ", error:" + e.stack);
        return undefined;
    }
}

// Save/ return valid Access Token
const requestAccessTokenAsync = async(user) => {
    try {
        if (enableAlexaAuthorization == true) {
            var now = (new Date().getTime());
            // Get user Grant Code
            var grant = await AlexaAuth.AlexaAuthGrantCode.findOne({user: user});
            // Get user Refresh Token
            var refresh = await AlexaAuth.AlexaAuthRefreshToken.findOne({user: user});
            // Check for valid Access Token
            var access = await AlexaAuth.AlexaAuthAccessToken.findOne({user: user, expires: {$gt: now}});
            // Validate responses, confirm what user has that is valid
            var hasGrantCode = getSafe(() => grant.code);
            var hasRefreshToken = getSafe(() => refresh.token);
            var hasAccessToken = getSafe(() => access.token);
            // Return existing, valid Access Token
            if (hasGrantCode != undefined && hasRefreshToken != undefined && hasAccessToken != undefined) {
                logger.log('verbose', "[AlexaAuth] Returned existing Access Token for user: " + user.username);
                return access;
            }
            // Use existing Grant Code and Refresh Token to request new Access Token
            else if (hasGrantCode != undefined && hasRefreshToken != undefined && hasAccessToken == undefined) {
                // Build POST data
                var formData = {
                    grant_type : "refresh_token",
                    refresh_token: refresh.token,
                    client_id : client_id,
                    client_secret : client_secret
                };
                // Use Amazon Auth service to request Access Token and await response
                var response = await axios({
                    method: 'post',
                    url: 'https://api.amazon.com/auth/o2/token',
                    data: querystring.stringify(formData),
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                  });
                // Successful POST
                logger.log('debug', "[AlexaAuth] Refresh Token status code: " + response.status);
                // Build require variables
                //var jsonBody = JSON.parse(response.data);
                logger.log('debug', "[AlexaAuth] Refresh Token response:" + JSON.stringify(response.data));
                var today = new Date();
                var expires = today.getTime() + response.data.expires_in*1000;
                // Create new Access Token
                var accessToken = new AlexaAuth.AlexaAuthAccessToken({
                    token: response.data.access_token,
                    user: user,
                    grant: grant,
                    expires: expires
                });
                // Save Access Token
                await accessToken.save();
                // Return Access Token
                logger.log('verbose', "[AlexaAuth] Successfully requested Access Token for user: " + user.username);
                return accessToken;
            }
            // Use existing Grant Code to request new Refresh Token and Access Token
            else if (hasGrantCode != undefined && hasRefreshToken == undefined && hasAccessToken == undefined) {
                // Build POST data
                var formData = {
                    grant_type : "authorization_code",
                    code: grant.code,
                    client_id : client_id,
                    client_secret : client_secret
                };
                // Use Amazon Auth service to request Refresh Token and Access Token
                var response = await axios({
                    method: 'post',
                    url: 'https://api.amazon.com/auth/o2/token',
                    data: querystring.stringify(formData),
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                  });
                // Successful POST
                logger.log('verbose', "[AlexaAuth] Grant Code status code: " + response.status);
                // Build require variables
                logger.log('verbose', "[AlexaAuth] Grant Code only response:" + JSON.stringify(response.data));
                var today = new Date();
                var expires = today.getTime() + response.data.expires_in*1000;
                // Create new Refresh Token
                var refreshToken = new AlexaAuth.AlexaAuthRefreshToken({
                    token: response.data.refresh_token,
                    user: user
                });
                // Create new Access Token
                var accessToken = new AlexaAuth.AlexaAuthAccessToken({
                    token: response.data.access_token,
                    user: user,
                    grant: grant,
                    expires: expires
                });
                // Save Refresh Token
                await refreshToken.save();
                // Save Access Token
                await accessToken.save();
                // Return Access Token
                logger.log('verbose', "[AlexaAuth] Successfully requested Refresh Token and Access Token for user: " + user.username);
                return accessToken;
            }
            // User needs to un-link/ re-link Amazon account, no grant code
            else if (hasGrantCode == undefined) {
                logger.log('error', "[AlexaAuth] No Alexa Grant Code for user: " + user.username);
                return undefined;
            }
        }
        else {
            logger.log('warn', "[AlexaAuth] enableAlexaAuthorization is DISABLED");
            return undefined;
        }
    }
    catch(e) {
        logger.log('error', "[AlexaAuth] Error requesting Access Token for user: " + user.username + ", error: " + e.stack);
        return undefined;
    }
}

// Provide Alexa-formatted State Properties
const queryDeviceStateAsync = async(device) => {
    try {
        // Convert "model" object class to JSON object so that properties are query-able
        var deviceJSON = JSON.parse(JSON.stringify(device));
        // Check device is set to report state, Only respond if device element 'reportState' is set to true
        if (deviceJSON && deviceJSON.hasOwnProperty('reportState') && deviceJSON.reportState == true) {
            // Check device has 'state' element, in order to generate properties
            if (deviceJSON.hasOwnProperty('state')) {
                // Inspect state element and build response based upon device type /state contents
                var properties = [];
                deviceJSON.capabilities.forEach(function(capability) {
                    switch (capability)  {
                        case "BrightnessController":
                            // Return brightness percentage
                            if (deviceJSON.state.hasOwnProperty('brightness') && deviceJSON.state.hasOwnProperty('time')) {
                                properties.push({
                                        "namespace": "Alexa.BrightnessController",
                                        "name": "brightness",
                                        "value": deviceJSON.state.brightness,
                                        "timeOfSample": deviceJSON.state.time,
                                        "uncertaintyInMilliseconds": 1000
                                    });
                            }
                            break;
                        case "ChannelController":
                            // Return Channel State - no reportable state as of December 2018
                            break;
                        case "ColorController":
                            // Return color
                            if (deviceJSON.state.hasOwnProperty('colorHue') && deviceJSON.state.hasOwnProperty('colorSaturation') && deviceJSON.state.hasOwnProperty('colorBrightness') && deviceJSON.state.hasOwnProperty('time')) {
                                properties.push({
                                        "namespace": "Alexa.ColorController",
                                        "name": "color",
                                        "value": {
                                            "hue": deviceJSON.state.colorHue,
                                            "saturation": deviceJSON.state.colorSaturation,
                                            "brightness": deviceJSON.state.colorBrightness
                                        },
                                        "timeOfSample": deviceJSON.state.time,
                                        "uncertaintyInMilliseconds": 1000
                                        });
                                }
                            break;
                        case "ContactSensor":
                            // Return detectionState
                            if (deviceJSON.state.hasOwnProperty('contact') && deviceJSON.state.hasOwnProperty('time')) {
                                properties.push({
                                        "namespace": "Alexa.ContactSensor",
                                        "name": "detectionState",
                                        "value": deviceJSON.state.contact,
                                        "timeOfSample": deviceJSON.state.time,
                                        "uncertaintyInMilliseconds": 1000
                                        });
                                }
                            break;
                        case "ColorTemperatureController":
                            // Return color temperature
                            if (deviceJSON.state.hasOwnProperty('colorTemperature') && deviceJSON.state.hasOwnProperty('time')) {
                                properties.push({
                                        "namespace": "Alexa.ColorTemperatureController",
                                        "name": "colorTemperatureInKelvin",
                                        "value": deviceJSON.state.colorTemperature,
                                        "timeOfSample": deviceJSON.state.time,
                                        "uncertaintyInMilliseconds": 1000
                                    });
                            }
                            break;
                        case "InputController":
                            // Return Input
                            if (deviceJSON.state.hasOwnProperty('input') && deviceJSON.state.hasOwnProperty('time')) {
                                properties.push({
                                        "namespace": "Alexa.InputController",
                                        "name": "input",
                                        "value": deviceJSON.state.input,
                                        "timeOfSample": deviceJSON.state.time,
                                        "uncertaintyInMilliseconds": 1000
                                    });
                            }
                            break;
                        case "LockController":
                            // Return Lock State
                            if (deviceJSON.state.hasOwnProperty('lock') && deviceJSON.state.hasOwnProperty('time')) {
                                properties.push({
                                        "namespace": "Alexa.LockController",
                                        "name": "lockState",
                                        "value": deviceJSON.state.lock,
                                        "timeOfSample": deviceJSON.state.time,
                                        "uncertaintyInMilliseconds": 1000
                                    });
                            }
                            break;
                        //case "ModeController":
                            // Return Mode State
                            //break;
                        case "MotionSensor":
                            // Return detectionState
                            if (deviceJSON.state.hasOwnProperty('motion') && deviceJSON.state.hasOwnProperty('time')) {
                                properties.push({
                                        "namespace": "Alexa.MotionSensor",
                                        "name": "detectionState",
                                        "value": deviceJSON.state.motion,
                                        "timeOfSample": deviceJSON.state.time,
                                        "uncertaintyInMilliseconds": 1000
                                        });
                                }
                            break;
                        case "PlaybackController":
                            // Return Playback State - no reportable state as of November 2018
                            break;
                        case "PercentageController":
                            // Return Power State
                            if (deviceJSON.state.hasOwnProperty('percentage') && deviceJSON.state.hasOwnProperty('time')) {
                                properties.push({
                                            "namespace": "Alexa.PercentageController",
                                            "name": "percentage",
                                            "value": deviceJSON.state.percentage,
                                            "timeOfSample": deviceJSON.state.time,
                                            "uncertaintyInMilliseconds": 1000
                                    });
                            }
                            break;
                        case "PowerController":
                            // Return Power State
                            if (deviceJSON.state.hasOwnProperty('power') && deviceJSON.state.hasOwnProperty('time')) {
                                properties.push({
                                            "namespace": "Alexa.PowerController",
                                            "name": "powerState",
                                            "value": deviceJSON.state.power,
                                            "timeOfSample": deviceJSON.state.time,
                                            "uncertaintyInMilliseconds": 1000
                                    });
                            }
                            break;
                        case "RangeController":
                            // Interior and Exterior Blinds
                            if (deviceJSON.state.hasOwnProperty('rangeValue') && deviceJSON.state.hasOwnProperty('time') && (deviceJSON.displayCategories.indexOf('INTERIOR_BLIND') > -1 || deviceJSON.displayCategories.indexOf('EXTERIOR_BLIND') > -1)) {
                                properties.push({
                                    "namespace": "Alexa.RangeController",
                                    "instance" : "Blind.Lift",
                                    "name": "rangeValue",
                                    "value": deviceJSON.state.rangeValue,
                                    "timeOfSample": deviceJSON.state.time,
                                    "uncertaintyInMilliseconds": 1000
                                    });
                            }
                            // General/ fall-back return rangeValue
                            else if (deviceJSON.state.hasOwnProperty('rangeValue') && deviceJSON.state.hasOwnProperty('time')) {
                                properties.push({
                                            "namespace": "Alexa.RangeController",
                                            "instance": "NodeRed.Fan.Speed",
                                            "name": "rangeValue ",
                                            "value": deviceJSON.state.rangeValue,
                                            "timeOfSample": deviceJSON.state.time,
                                            "uncertaintyInMilliseconds": 1000
                                    });
                            }
                            break;
                        // case "Speaker":
                        //     if (deviceJSON.state.hasOwnProperty('volume') && deviceJSON.state.hasOwnProperty('time')) {
                        //         properties.push({
                        //                     "namespace": "Alexa.Speaker",
                        //                     "name": "volume ",
                        //                     "value": deviceJSON.state.volume,
                        //                     "timeOfSample": deviceJSON.state.time,
                        //                     "uncertaintyInMilliseconds": 1000
                        //             });
                        //     }
                        //     if (deviceJSON.state.hasOwnProperty('mute') && deviceJSON.state.hasOwnProperty('time')) {
                        //         properties.push({
                        //                     "namespace": "Alexa.Speaker",
                        //                     "name": "muted ",
                        //                     "value": deviceJSON.state.mute,
                        //                     "timeOfSample": deviceJSON.state.time,
                        //                     "uncertaintyInMilliseconds": 1000
                        //             });
                        //     }
                        //     break;
                        case "TemperatureSensor":
                            // Return temperature
                            if (deviceJSON.state.hasOwnProperty('temperature') && deviceJSON.state.hasOwnProperty('time')) {
                                properties.push({
                                    "namespace": "Alexa.TemperatureSensor",
                                    "name": "temperature",
                                    "value": {
                                        "value": deviceJSON.state.temperature,
                                        "scale": deviceJSON.attributes.temperatureScale.toUpperCase()
                                        },
                                    "timeOfSample": deviceJSON.state.time,
                                    "uncertaintyInMilliseconds": 1000
                                });
                            }
                            break;
                        case "ThermostatController":
                            // Return thermostatSetPoint
                            if (deviceJSON.state.hasOwnProperty('thermostatSetPoint') && deviceJSON.state.hasOwnProperty('thermostatMode') && deviceJSON.state.hasOwnProperty('time')) {
                                properties.push({
                                        "namespace":"Alexa.ThermostatController",
                                        "name":"targetSetpoint",
                                        "value":{
                                            "value":deviceJSON.state.thermostatSetPoint,
                                            "scale":deviceJSON.attributes.temperatureScale.toUpperCase()
                                            },
                                        "timeOfSample":deviceJSON.state.time,
                                        "uncertaintyInMilliseconds":1000
                                    });
                                properties.push({
                                        "namespace":"Alexa.ThermostatController",
                                        "name":"thermostatMode",
                                        "value":deviceJSON.state.thermostatMode,
                                        "timeOfSample":deviceJSON.state.time,
                                        "uncertaintyInMilliseconds":1000
                                    });
                            }
                            break;
                    }
                });
                // Add required connectivity 'OK' property namespace
                properties.push({
                    "namespace": "Alexa.EndpointHealth",
                    "name": "connectivity",
                    "value": {
                        "value": "OK"
                    },
                    "timeOfSample": deviceJSON.state.time,
                    "uncertaintyInMilliseconds": 1000
                });
                // Return properties
                logger.log('debug', "[Alexa State] State response properties: " + JSON.stringify(properties));
                return properties;
            }
            else {
                // Device has no state, return undefined
                logger.log('warn',"[Alexa State] No state found for endpointId:" + deviceJSON.endpointId);
                return undefined;
            }
        }
        else if (deviceJSON && deviceJSON.hasOwnProperty('reportState') && deviceJSON.reportState == false) {
            logger.log('debug',"[Alexa State] State requested for device: " + deviceJSON.endpointId +  " but device state reporting disabled");
            var properties = [];
            // Add only connectivity 'OK' property namespace
            properties.push({
                "namespace": "Alexa.EndpointHealth",
                "name": "connectivity",
                "value": {
                    "value": "OK"
                },
                "timeOfSample": deviceJSON.state.time,
                "uncertaintyInMilliseconds": 1000
            });
            // Return properties
            return properties;
        }
        else {
            logger.log('warn', "[Alexa State] Device: " + deviceJSON.endpointId +  " has no reportState attribute, check MongoDB schema");
            return undefined;
        }
    }
    catch(e) {
        logger.log('error', "[Alexa State] Device: " + deviceJSON.endpointId +  " has no reportState attribute, check MongoDB schema");
        return undefined;
    }
}

// Set Out of Band State Report to Alexa
const sendStateAsync = async(user, state) => {
    try {
        // Get user region/ check against list to assign URL variable and validate
        var stateURI;
        switch (user.region) {
            case 'Europe': // Europe
                stateURI = 'https://api.eu.amazonalexa.com/v3/events';
                break;
            case 'Americas': // North America
                stateURI = 'https://api.amazonalexa.com/v3/events';
                break
            case 'Asia': // Far East
                stateURI = 'https://api.fe.amazonalexa.com/v3/events';
                break;
            case 'Oceania': // APAC
                stateURI = 'https://api.fe.amazonalexa.com/v3/events';
                break;
        }
        // Get valid Access Token for User
        var accessToken = await requestAccessTokenAsync(user);
        // Add valid Access Token to State Response
        state.event.endpoint.scope.token = accessToken.token
        // POST State Update to Alexa API
        var response = await axios({
            method: 'post',
            url: stateURI,
            data: state,
            headers: {
                'Authorization': 'Bearer ' + accessToken.token,
                'Content-Type': 'application/json'
            }
          });
        // Log Status Code/ Response to Console
        logger.log('verbose', "[Alexa Send State] Send State Report response status code: " + response.status);
        // Assess response code
        if (response.status == 202) {
            // Successful response
            logger.log('verbose', "[Alexa Send State] Sent State report for user: " + user.username);        }
        else if (response.status == 403) {
            // Skill has been unlinked from users account, clean-up user grants, refresh token and access tokens
            logger.log('warn', "[Alexa Send State] User: " + user.username + " no longer has linked account");
        }
        else {
            // Successful response
            logger.log('warn', "[Alexa Send State] Change report failed, response code:" + response.status)
        }
    }
    catch(e) {
        // Handle failure
        logger.log('error', "[Alexa Send State] Failed to send change report for user: " + user.username + ", to Alexa failed, error" + e.stack);
    }
}

// Nested attribute/ element tester
function getSafe(fn) {
	//logger.log('debug', "[getSafe] Checking element exists:" + fn)
	try {
		return fn();
    } catch (e) {
		//logger.log('debug', "[getSafe] Element not found:" + fn)
        return undefined;
    }
}

module.exports = {
    saveGrantAsync,
    queryDeviceStateAsync,
    requestAccessTokenAsync,
    sendStateAsync
}