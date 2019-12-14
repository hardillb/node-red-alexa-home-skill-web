///////////////////////////////////////////////////////////////////////////
// Depends
///////////////////////////////////////////////////////////////////////////
const request = require('request');
var Account = require('../models/account');
var Devices = require('../models/devices');
var logger = require('../loaders/logger');
var AlexaAuth = require('../models/alexa-auth');
///////////////////////////////////////////////////////////////////////////
// Variables
///////////////////////////////////////////////////////////////////////////
var debug = (process.env.ALEXA_DEBUG || false);
var enableAlexaAuthorization = false;
if (!process.env.ALEXA_CLIENTID && !process.env.ALEXA_CLIENTSECRET) {
    logger.log('warn', "[AlexaAuth API] ALEXA_CLIENTID and ALEXA_CLIENTSECRET environment variables undefined, state reporting disabled!");
}
else {
    var client_id = process.env.ALEXA_CLIENTID;
    var client_secret = process.env.ALEXA_CLIENTSECRET;
    enableAlexaAuthorization = true;
}
///////////////////////////////////////////////////////////////////////////
// Exports
///////////////////////////////////////////////////////////////////////////
// Store GrantCode
module.exports.saveGrant = function saveGrant(user, grantcode, callback){
    var pDeleteAlexaAuthGrant = AlexaAuth.AlexaAuthGrantCode.deleteMany({user: user});
    var pDeleteAlexaAuthRefresh = AlexaAuth.AlexaAuthRefreshToken.deleteMany({user: user});
    var pDeleteAlexaAuthAcess = AlexaAuth.AlexaAuthAccessToken.deleteMany({user: user});
    Promise.all([pDeleteAlexaAuthGrant, pDeleteAlexaAuthRefresh, pDeleteAlexaAuthAcess]).then(result => {
        // Create and store the GrantCode
        var newGrant = new AlexaAuth.AlexaAuthGrantCode({
            user: user,
            code: grantcode
        });
        newGrant.save(function(err) {
            if (!err) {
                logger.log('verbose', "[AlexaAuth API] Saved Alexa/Authorization GrantCode for user: " + user.username + ", grant:" + JSON.stringify(newGrant));
                // Request refresh and access token
                requestAccessToken(user, function(accesstoken) {
                    if (accesstoken != undefined) {
                        callback(newGrant);
                    }
                    else {callback(undefined)}
                });
            }
            else {
                logger.log('verbose', "[AlexaAuth API] Failed to save Alexa/Authorization GrantCode for user: " + user.username + ", error:" + err);
                callback(undefined);
            }
        });
    }).catch(error => {
        logger.log('error', "[AlexaAuth API] Error deleteing existing Alexa/Authorization GrantCodes, error:" + error);
        callback(undefined);
    });

}

// Generate stateUpdate for use in sendState
module.exports.queryDeviceState = function queryDeviceState(device, callback) {
    var deviceJSON = JSON.parse(JSON.stringify(device)); // Convert "model" object class to JSON object so that properties are query-able
    if (deviceJSON && deviceJSON.hasOwnProperty('reportState')) {
        if (deviceJSON.reportState = true) { // Only respond if device element 'reportState' is set to true
            if (deviceJSON.hasOwnProperty('state')) {
                    // Inspect state element and build response based upon device type /state contents
                    // Will need to group multiple states into correct update format
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

                    properties.push({
                        "namespace": "Alexa.EndpointHealth",
                        "name": "connectivity",
                        "value": {
                            "value": "OK"
                        },
                        "timeOfSample": deviceJSON.state.time,
                        "uncertaintyInMilliseconds": 1000
                    });
                    logger.log('debug', "[State API] State response properties: " + JSON.stringify(properties));
                    callback(properties);
                    }
                else {
                    // Device has no state, return as such
                    logger.log('warn',"[State API] No state found for endpointId:" + deviceJSON.endpointId);
                    callback(undefined);
                }
            }
            // State reporting not enabled for device, send error code
            else {
                logger.log('debug',"[State API] State requested for device: " + deviceJSON.endpointId +  " but device state reporting disabled");
                var properties = [];
                properties.push({
                    "namespace": "Alexa.EndpointHealth",
                    "name": "connectivity",
                    "value": {
                        "value": "OK"
                    },
                    "timeOfSample": deviceJSON.state.time,
                    "uncertaintyInMilliseconds": 1000
                });
                callback(properties);
            }
        }
        // 'reportState' element missing on device, send error code
        else {
            logger.log('warn', "[State API] Device: " + deviceJSON.endpointId +  " has no reportState attribute, check MongoDB schema");
            callback(undefined);
        }
}

// Send Event
// Going to need username, endpointId, messageId (it if exists), correlationToken
module.exports.sendState = function sendState(user, state) {
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

    // Request access token and send change report
    requestAccessToken(user, function(accesstoken) {
        if (accesstoken != undefined) {
            state.event.endpoint.scope.token = accesstoken.token;
            // logger.log('verbose', "[State API] Sending Alexa Change Report to: " + stateURI + ", state:" +  JSON.stringify(state));
            // Send state update
            request.post({
                url: stateURI,
                    headers:{
                        'Authorization': 'Bearer ' + accesstoken.token,
                        'Content-Type': 'application/json'
                    },
                    json: state
            }, function(err,res, body){
                if (err) {
                    logger.log('warn', "[State API] Change report for user: " + user.username + ", to Alexa failed, error" + err);
                }
                else {
                    if (res.statusCode == 202) {
                        logger.log('verbose', "[State API] Change report for user: " + user.username + ", to Alexa successful!");
                    }
                    else if (res.statusCode == 403) {
                        // Skill has been unlinked from users account, clean-up user grants, refresh token and access tokens
                    }
                    else {logger.log('warn', "[State API] Change report failed, reponse code:" + res.statusCode)}
                }
            });
        }
    });
}

// Check user is actually enabled / account-linked for Alexa
module.exports.isAlexaUser = function isAlexaUser(user, callback) {
    if (user.activeServices && user.activeServices.indexOf('Amazon') != -1) {
        callback(true);
    }
    else {
        callback(false);
    }
}

// Use stored GrantCode to request access token and refresh token
// module.exports.requestAccessToken = function requestAccessToken(user, callback) {
function requestAccessToken(user, callback) {
    if (enableAlexaAuthorization == true) {
        var now = (new Date().getTime());
        var pGrantCodes = AlexaAuth.AlexaAuthGrantCode.findOne({user: user});
        var pRefreshTokens = AlexaAuth.AlexaAuthRefreshToken.findOne({user: user});
        var pAccessTokens = AlexaAuth.AlexaAuthAccessToken.findOne({user: user, expires: {$gt: now}});
        Promise.all([pGrantCodes, pRefreshTokens, pAccessTokens]).then(([grant, refreshtoken, accesstoken]) => {
            // User had grant code only, no refresh token, no (valid) access token
            var hasGrantCode = getSafe(() => grant.code);
            var hasRefreshToken = getSafe(() => refreshtoken.token);
            var hasAccessToken = getSafe(() => accesstoken.token);

            // if (grant && grant.code && !refreshtoken && !refreshtoken.token && !accesstoken && !accesstoken.token) { // Request new access token using grant code
            if (hasGrantCode != undefined && hasRefreshToken == undefined && hasAccessToken == undefined) { // Request new access token using grant code
                //logger.log('verbose', "[AlexaAuth API] User: " + user.username + " has existing grant code only");
                request.post({
                    url: 'https://api.amazon.com/auth/o2/token',
                    form: {
                        grant_type : "authorization_code",
                        code: grant.code,
                        client_id : client_id,
                        client_secret : client_secret
                        }
                    },
                    function(err,res, body){
                        if (err) {
                            logger.log('error', "[AlexaAuth API] Failed to request access token using grant code for user: " + user.username + ", error: " + err);
                            callback(undefined);
                        }
                        else if (res.statusCode == 200) { // Store the RefreshToken and AccessToken
                            var jsonBody = JSON.parse(body);

                            // Look to add statusCode == 200 handler, w/ catch-all else and callback(undefined)
                            logger.log('error', "[AlexaAuth API] Grant Code status code: " + res.statusCode);
                            logger.log('debug', "[AlexaAuth API] Grant Code only response:" + JSON.stringify(jsonBody));

                            var refreshToken = new AlexaAuth.AlexaAuthRefreshToken({
                                token: jsonBody.refresh_token,
                                user: user
                            });

                            var today = new Date();
                            var expires = today.getTime() + jsonBody.expires_in*1000;

                            var accessToken = new AlexaAuth.AlexaAuthAccessToken({
                                token: jsonBody.access_token,
                                user: user,
                                grant: grant,
                                expires: expires
                            });
                            var pSaveRefreshToken = new Promise((resolve, reject) => {
                                refreshToken.save(function(err) {
                                    if (!err) {resolve(refreshToken)}
                                    else {
                                        logger.log('error', "[AlexaAuth API] Failed to save refreshToken for:" + user.username);
                                        reject(err)
                                    }
                                });
                            });
                            var pSaveAccessToken = new Promise((resolve, reject) => {
                                accessToken.save(function(err) {
                                    if (!err) {resolve(accessToken)}
                                    else {
                                        logger.log('error', "[AlexaAuth API] Failed to save accessToken for:" + user.username)
                                        reject(err)
                                    }
                                });
                            });
                            Promise.all([pSaveRefreshToken, pSaveAccessToken]).then(([refresh, access]) => {
                                logger.log('debug', "[AlexaAuth API] Saved RefreshToken for user: " + user.username + ", token:" + JSON.stringify(refresh));
                                logger.log('debug', "[AlexaAuth API] Saved AccessToken for user: " + user.username + ", token:" + JSON.stringify(access));
                                callback(access);
                            }).catch(err => {
                                logger.log('error', "[AlexaAuth API] requestAccessToken error:" + err);
                                callback(undefined);
                            });
                        }
                        else {
                            logger.log('error', "[AlexaAuth API] Failed to request refresh and access token using grant code for user: " + user.username);
                            logger.log('error', "[AlexaAuth API] Request status code: " + res.statusCode);
                            logger.log('error', "[AlexaAuth API] Request response:" + JSON.stringify(jsonBody));
                            callback(undefined);
                        }
                    }
                );
            }
            // User had grant code and refresh token, no (valid) access token
            else if (hasGrantCode != undefined && hasRefreshToken != undefined && hasAccessToken == undefined) {
            //else if (grant && refreshtoken && !accesstoken) { // Request new access token using refresh token
                //logger.log('verbose', "[AlexaAuth API] User: " + user.username + " has existing grant code and refresh token");
                request.post({
                    url: 'https://api.amazon.com/auth/o2/token',
                    form: {
                        grant_type : "refresh_token",
                        refresh_token: refreshtoken.token,
                        client_id : client_id,
                        client_secret : client_secret
                        }
                    },
                    function(err,res, body){
                        if (err) {
                            logger.log('error', "[AlexaAuth API] Failed to request access token using grant code for user: " + user.username + ", error: " + err);
                            callback(undefined);
                        }
                        else if (res.statusCode == 200) {
                            logger.log('debug', "[AlexaAuth API] Access Token status code: " + res.statusCode);

                            // Store the AccessToken
                            var jsonBody = JSON.parse(body);
                            logger.log('debug', "[AlexaAuth API] Access Token response:" + JSON.stringify(jsonBody));

                            var today = new Date();
                            var expires = today.getTime() + jsonBody.expires_in*1000;

                            var accessToken = new AlexaAuth.AlexaAuthAccessToken({
                                token: jsonBody.access_token,
                                user: user,
                                grant: grant,
                                expires: expires
                            });
                            var pSaveAccessToken = new Promise((resolve, reject) => {
                                accessToken.save(function(err) {
                                    if (!err) {resolve(accessToken)}
                                    else {
                                        logger.log('error', "[AlexaAuth API] Failed to save accessToken for:" + user.username)
                                        reject(err)
                                    }
                                });
                            });
                            Promise.all([pSaveAccessToken]).then(([access]) => {
                                logger.log('debug', "[AlexaAuth API] Saved AccessToken for user: " + user.username + ", token:" + JSON.stringify(access));
                                callback(access);
                            }).catch(err => {
                                logger.log('error', "[AlexaAuth API] requestAccessToken error:" + err);
                                callback(undefined);
                            });
                        }
                        else {
                            logger.log('error', "[AlexaAuth API] Failed to request access token using grant code for user: " + user.username);
                            logger.log('error', "[AlexaAuth API] Access Token status code: " + res.statusCode);
                            logger.log('error', "[AlexaAuth API] Access Token response:" + JSON.stringify(jsonBody));
                            callback(undefined);
                        }
                    }
                );
            }
            // User had grant code and refresh token, and valid access token
            else if (hasGrantCode != undefined && hasRefreshToken != undefined && hasAccessToken != undefined) {
            //else if (grant && refreshtoken && accesstoken) {
                //logger.log('verbose', "[AlexaAuth API] User: " + user.username + " has existing grant code, refresh token and valid access token");
                logger.log('debug', "[AlexaAuth API] Returned existing AccessToken for user: " + user.username + ", token:" + JSON.stringify(accesstoken));
                callback(accesstoken);
            }
            else if (hasGrantCode == undefined) { // User needs to un-link/ re-link Amazon account, no grant code
                logger.log('warn', "[AlexaAuth API] No Alexa Grant Code for user: " + user.username);
                callback(undefined);
            }
            else { // Shouldn't get here!
                callback(undefined);
            }
        });
    }
    else {
        logger.log('warn', "[AlexaAuth API] enableAlexaAuthorization is DISABLED");
        callback(undefined);
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