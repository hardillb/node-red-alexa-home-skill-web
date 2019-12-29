///////////////////////////////////////////////////////////////////////////
// Depends
///////////////////////////////////////////////////////////////////////////
const axios = require('axios');
const querystring = require('querystring');
var logger = require('../loaders/logger');
var AlexaAuth = require('../models/alexa-auth');
const removeUserServices = require('../services/func-services').removeUserServices;
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
        logger.log('error', "[Alexa State] Device: has no reportState attribute, check MongoDB schema, device: " + JSON.stringify(device));
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
        // User no-longer has skill linked with Amazon account, see: https://developer.amazon.com/en-US/docs/alexa/smarthome/debug-your-smart-home-skill.html
        if (e.response && e.response.status && e.response.status == 403) {
            logger.log('warn', "[Alexa Send State] Failed to send change report for user: " + user.username + ", to Alexa, user no-longer has linked skill.");
            // Remove 'Amazon' from users' active services
			removeUserServices(user.username, "Amazon");
        }
        // Handle failures
        else {logger.log('error', "[Alexa Send State] Failed to send change report for user: " + user.username + ", to Alexa failed, error" + e.stack)}
    }
}

// Validate command where limits are in-place, i.e. min/ max thermostat temperature or bulb colour temperature
const validateCommandAsync = async(device, req) => {
    try{
        var deviceJSON = JSON.parse(JSON.stringify(device));
        var name = req.body.directive.header.name;
        var namespace = req.body.directive.header.namespace;
        // Check attributes.colorTemperatureRange, send 417 to Lambda (VALUE_OUT_OF_RANGE) response if values are out of range
        if (namespace == "Alexa.ColorTemperatureController" && name == "SetColorTemperature") {
            var compare = req.body.directive.payload.colorTemperatureInKelvin;
            // Handle Out of Range
            var hasColorTemperatureRange = getSafe(() => deviceJSON.attributes.colorTemperatureRange);
            if (hasColorTemperatureRange != undefined) {
                if (compare < deviceJSON.attributes.colorTemperatureRange.temperatureMinK || compare > deviceJSON.attributes.colorTemperatureRange.temperatureMaxK) {
                    logger.log('warn', "[Alexa Command] User: " + req.user.username + ", requested color temperature: " + compare + ", on device: " + req.body.directive.endpoint.endpointId + ", which is out of range: " + JSON.stringify(deviceJSON.attributes.colorTemperatureRange));
                    // Send 417 HTTP code back to Lambda, Lambda will send correct error message to Alexa
                    //res.status(417).send();
                    //validationStatus = false;
                    return {status: false, response: 417};
                }
            }
            else {logger.log('debug', "[Alexa Command] Device: " + req.body.directive.endpoint.endpointId + " does not have attributes.colorTemperatureRange defined")}
        }
        // Check attributes.temperatureRange, send 416 to Lambda (TEMPERATURE_VALUE_OUT_OF_RANGE) response if values are out of range
        else if (req.body.directive.header.namespace == "Alexa.ThermostatController" && req.body.directive.header.name == "SetTargetTemperature") {
            var compare = req.body.directive.payload.targetSetpoint.value;
            // Handle Temperature Out of Range
            var hasTemperatureRange = getSafe(() => deviceJSON.attributes.temperatureRange);
            if (hasTemperatureRange != undefined) {
                if (compare < deviceJSON.attributes.temperatureRange.temperatureMin || compare > deviceJSON.attributes.temperatureRange.temperatureMax) {
                    logger.log('warn', "[Alexa Command] User: " + req.user.username + ", requested temperature: " + compare + ", on device: " + req.body.directive.endpoint.endpointId + ", which is out of range: " + JSON.stringify(deviceJSON.attributes.temperatureRange));
                    // Send 416 HTTP code back to Lamnda, Lambda will send correct error message to Alexa
                    //res.status(416).send();
                    //validationStatus = false;
                    return {status: false, response: 416};
                }
            }
            else {logger.log('debug', "[Alexa Command] Device: " + req.body.directive.endpoint.endpointId + " does not have attributes.temperatureRange defined")}
        }
        // Generate 418 error, INVALID_DIRECTIVE on ModeController AdjustMode
        // if (req.body.directive.header.namespace == "Alexa.ModeController" && req.body.directive.header.name == "AdjustMode" && (deviceJSON.displayCategories.indexOf('INTERIOR_BLIND') > -1 || deviceJSON.displayCategories.indexOf('EXTERIOR_BLIND') > -1)) {
        // 	logger.log('warn', "[Alexa API] User: " + req.user.username + ", requested AdjustMode directive which is unsupported on the device type." );
        // 	res.status(418).send();
        // 	validationStatus = false;
        // }
        else {
            return {status: true};
        }
    }
    catch(e) {
        logger.log('error', "[Alexa Command] Validation of command failed, error: " + e.stack);
        return {status: false, response : undefined}
    }
}
const buildCommandResponseAsync = async(req) => {
}


// Replace Capability function, replaces 'placeholders' stored under device.capabilities in mongoDB with Amazon JSON
const replaceCapabilityAsync = async(capability, reportState, attributes, type) => {
	// BrightnessController
	if(capability == "BrightnessController")  {
		return {
				"type": "AlexaInterface",
				"interface": "Alexa.BrightnessController",
				"version": "3",
				"properties": {
					"supported": [{
						"name": "brightness"
					}],
					"proactivelyReported": reportState,
					"retrievable": reportState
				}
			};
	}
	// ChannelController
	if(capability == "ChannelController") {
		return {
			"type": "AlexaInterface",
			"interface": "Alexa.ChannelController",
			"version": "3",
			};
	}
	// ColorController
	if(capability == "ColorController")  {
		return {
				"type": "AlexaInterface",
				"interface": "Alexa.ColorController",
				"version": "3",
				"properties": {
					"supported": [{
						"name": "color"
					}],
					"proactivelyReported": reportState,
					"retrievable": reportState
				}
			};
	}
	// ContactSensor
	if(capability == "ContactSensor")  {
		return {
				"type": "AlexaInterface",
				"interface": "Alexa.ContactSensor",
				"version": "3",
				"properties": {
					"supported": [{
						"name": "detectionState"
					  }],
					"proactivelyReported": reportState,
					"retrievable": reportState
				}
			};
	}
	// ColorTemperatureController
	if(capability == "ColorTemperatureController")  {
		return {
				"type": "AlexaInterface",
				"interface": "Alexa.ColorTemperatureController",
				"version": "3",
				"properties": {
					"supported": [{
						"name": "colorTemperatureInKelvin"
					}],
					"proactivelyReported": reportState,
					"retrievable": reportState
				}
			};
	}
	// InputController, pre-defined 4x HDMI inputs and phono
	if(capability == "InputController") {
		return {
			"type": "AlexaInterface",
			"interface": "Alexa.InputController",
			"version": "3",
			"inputs": [{
				"name": "HDMI1"
			  },
			  {
				"name": "HDMI2"
			  },
			  {
				"name": "HDMI3"
			  },
			  {
				"name": "HDMI4"
			  },
			  {
				"name": "phono"
			  },
			  {
				"name": "audio1"
			  },
			  {
				"name": "audio2"
			  },
			  {
				"name": "chromecast"
			  }
			]};
	}
	// LockController
	if(capability == "LockController")  {
		return {
				"type": "AlexaInterface",
				"interface": "Alexa.LockController",
				"version": "3",
				"properties": {
					"supported": [{
						"name": "lockState"
					}],
					"proactivelyReported": reportState,
					"retrievable": reportState
				}
			};
	}
	// MotionSensor
	if(capability == "MotionSensor")  {
		return {
				"type": "AlexaInterface",
				"interface": "Alexa.MotionSensor",
				"version": "3",
				"properties": {
					"supported": [{
						"name": "detectionState"
						}],
					"proactivelyReported": reportState,
					"retrievable": reportState
				}
			};
	}
	// PercentageController
	if(capability == "PercentageController") {
		return {
			"type": "AlexaInterface",
			"interface": "Alexa.PercentageController",
			"version": "3",
			"properties": {
				"supported": [{
					"name": "percentage"
				}],
				"proactivelyReported": reportState,
				"retrievable": reportState
			}
		};
	}
	// PlaybackController
	if(capability == "PlaybackController") {
		return {
			"type": "AlexaInterface",
			"interface": "Alexa.PlaybackController",
			"version": "3",
			"supportedOperations" : ["Play", "Pause", "Stop", "FastForward", "StartOver", "Previous", "Rewind", "Next"]
			};
	}
	// PowerController
	if(capability == "PowerController") {
		return {
			"type": "AlexaInterface",
			"interface": "Alexa.PowerController",
			"version": "3",
			"properties": {
				"supported": [{
					"name": "powerState"
				}],
				"proactivelyReported": reportState,
				"retrievable": reportState
				}
			};
	}
	// RangeController | Interior and Exterior Blinds
	if(capability == "RangeController" && (type.indexOf("INTERIOR_BLIND") > -1 || type.indexOf("EXTERIOR_BLIND") > -1)) {
		return {
			"type": "AlexaInterface",
			"interface": "Alexa.RangeController",
			"instance": "Blind.Lift",
			"version": "3",
			"properties": {
				"supported": [
					{
						"name": "rangeValue"
					}
				],
				"proactivelyReported": true,
				"retrievable": true
			},
			"capabilityResources": {
				"friendlyNames": [
				{
					"@type": "asset",
					"value": {
						"assetId": "Alexa.Setting.Opening"
					}
				}
				]
			},
			"configuration": {
				"supportedRange": {
					"minimumValue": 0,
					"maximumValue": 100,
					"precision": 1
				},
				"unitOfMeasure": "Alexa.Unit.Percent"
			},
			"semantics": {
				"actionMappings": [
				{
					"@type": "ActionsToDirective",
					"actions": ["Alexa.Actions.Close"],
					"directive": {
						"name": "SetRangeValue",
						"payload": {
							"rangeValue": 0
						}
					}
				},
				{
					"@type": "ActionsToDirective",
					"actions": ["Alexa.Actions.Open"],
					"directive": {
						"name": "SetRangeValue",
						"payload": {
							"rangeValue": 100
						}
					}
				},
				{
					"@type": "ActionsToDirective",
					"actions": ["Alexa.Actions.Lower"],
					"directive": {
						"name": "AdjustRangeValue",
						"payload": {
							"rangeValueDelta": -10,
							"rangeValueDeltaDefault": false
						}
					}
				},
				{
					"@type": "ActionsToDirective",
					"actions": ["Alexa.Actions.Raise"],
					"directive": {
						"name": "AdjustRangeValue",
						"payload": {
							"rangeValueDelta": 10,
							"rangeValueDeltaDefault": false
						}
					}
				}
				],
				"stateMappings": [
				{
					"@type": "StatesToValue",
					"states": ["Alexa.States.Closed"],
					"value": 0
				},
				{
					"@type": "StatesToRange",
					"states": ["Alexa.States.Open"],
					"range": {
						"minimumValue": 1,
						"maximumValue": 100
					}
				}
				]
			}
			}
	}
	// RangeController
	if(capability == "RangeController") {
		return {
			"type": "AlexaInterface",
			"interface": "Alexa.RangeController",
			"version": "3",
			"instance": "NodeRed.Fan.Speed",
			"capabilityResources": {
			  "friendlyNames": [
				{
                    "@type": "text",
                    "value": {
                      "text": "Fan Speed",
                      "locale": "en-US"
                    }
				},
				{
                    "@type": "text",
                    "value": {
                      "text": "Position",
                      "locale": "en-US"
                    }
                }
			  ]
			},
			"properties": {
			  "supported": [
				{
				  "name": "rangeValue"
				}
			  ],
			  "proactivelyReported": reportState,
			  "retrievable": reportState
			},
			"configuration": {
			  "supportedRange": {
				"minimumValue": 1,
				"maximumValue": 10,
				"precision": 1
			  },
			  "presets": [
				{
					"rangeValue": 1,
					"presetResources": {
					  "friendlyNames": [
						{
						  "@type": "asset",
						  "value": {
							"assetId": "Alexa.Value.Low"
						  }
						},
                        {
                          "@type": "asset",
                          "value": {
                            "assetId": "Alexa.Value.Minimum"
                          }
                        }
					  ]
					}
				  },
				{
					"rangeValue": 5,
					"presetResources": {
					  "friendlyNames": [
						{
						  "@type": "asset",
						  "value": {
							"assetId": "Alexa.Value.Medium"
						  }
						}
					  ]
					}
				  },
				  {
					"rangeValue": 10,
					"presetResources": {
					  "friendlyNames": [
						{
						  "@type": "asset",
						  "value": {
							"assetId": "Alexa.Value.Maximum"
						  }
						},
						{
						  "@type": "asset",
						  "value": {
							"assetId": "Alexa.Value.High"
						  }
						}
					  ]
					}
				  }
			  ]
			}
		 };
	 }
	// Speaker
	if(capability == "Speaker") {
		return {
			"type": "AlexaInterface",
			"interface": "Alexa.Speaker",
			"version": "3",
			"properties":{
				"supported":[{
						"name":"volume"
					},
					{
						"name":"muted"
					}
				]}
			};
	}
	// SceneController
	if(capability == "SceneController") {
		return {
			"type": "AlexaInterface",
			"interface": "Alexa.SceneController",
			"version" : "3",
			"supportsDeactivation" : false
			};
	}
	// StepSpeaker
	if(capability == "StepSpeaker") {
		return {
			"type": "AlexaInterface",
			"interface": "Alexa.StepSpeaker",
			"version": "3",
			"properties":{
				"supported":[{
					  "name":"volume"
				   },
				   {
					  "name":"muted"
				   }
				]}
			};
	}
	// TemperatureSensor
	if(capability == "TemperatureSensor") {
		return {
			"type": "AlexaInterface",
			"interface": "Alexa.TemperatureSensor",
			"version" : "3",
			"properties": {
                "supported": [
                  {
                    "name": "temperature"
                  }
                ],
                "proactivelyReported": reportState,
                "retrievable": reportState
              }
			};
	}
	// ThermostatController - SinglePoint
	if(capability == "ThermostatController")  {
		var supportedModes;
		var hasModes = getSafe(() => attributes.thermostatModes);
		if (attributes != null && hasModes != undefined) {
			//supportedModes = attributes.thermostatModes;
			supportedModes = attributes.thermostatModes.filter(function(value, index, arr){
				// Google Home filter, remove modes that are not Alexa Compliant
				return value != "ON";
			});
		}
		else {
			supportedModes = ["HEAT","COOL","AUTO"];
		}
		return {
			"type": "AlexaInterface",
            "interface": "Alexa.ThermostatController",
            "version": "3",
            "properties": {
              "supported": [{
                  "name": "targetSetpoint"
                },
                {
                  "name": "thermostatMode"
                }
              ],
			  "proactivelyReported": reportState,
			  "retrievable": reportState
            },
            "configuration": {
              "supportsScheduling": false,
              "supportedModes": supportedModes
			}
		};
	}
};

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
    sendStateAsync,
    replaceCapabilityAsync,
    validateCommandAsync
}