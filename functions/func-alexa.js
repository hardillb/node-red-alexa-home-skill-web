///////////////////////////////////////////////////////////////////////////
// Depends
///////////////////////////////////////////////////////////////////////////
const request = require('request');
var Account = require('../models/account');
var logger = require('../config/logger');
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
    var pDeleteAlexaAuthGrant = AlexaAuth.AlexaAuthGrantCode.deleteOne({user: user});
    Promise.all([pDeleteAlexaAuthGrant]).then(result => {
        // Create and store the GrantCode
        var newGrant = new AlexaAuth.AlexaAuthGrantCode({
            user: user,
            code: grantcode
        });
        newGrant.save(function(err) {
            if (!err) {
                logger.log('verbose', "[AlexaAuth API] Saved Alexa/Authorization GrantCode for user:" + user.username + ", grant:" + JSON.stringify(newGrant));
                callback(newGrant);
            }
            else {
                logger.log('verbose', "[AlexaAuth API] Failed to save Alexa/Authorization GrantCode for user:" + user.username + ", error:" + err);
                callback(undefined);
            }
        });
    }).catch(error => {
        logger.log('error', "[AlexaAuth API] Error deleteing existing Alexa/Authorization GrantCodes, error:" + error);
        callback(undefined);
    });

}
// Use stored GrantCode to request access token and refresh token
module.exports.requestAccessToken = function requestAccessToken(user, callback) {
    if (enableAlexaAuthorization == true) {
        var now = (new Date().getTime());
        var pGrantCodes = AlexaAuth.AlexaAuthGrantCode.findOne({user: user});
        var pRefreshTokens = AlexaAuth.AlexaAuthRefreshToken.findOne({user: user});
        var pAccessTokens = AlexaAuth.AlexaAuthAccessTokens.findOne({user: user, expires: {$gt: now}});
        Promise.all([pGrantCodes, pRefreshTokens, pAccessTokens]).then(([grant, refreshtoken, accesstoken]) => {
            // User had grant code only, no refresh token, no (valid) access token
            if (grant && !refreshtoken && !accesstoken) { // Request new access token using grant code
                logger.log('verbose', "[Alexa Auth] User:" + user.username + " has existing grant code only");
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
                            logger.log('error', "[Alexa Auth] Failed to request access token using grant code for user:" + user.username + ", error: " + err);
                            callback(undefined);
                        } else { // Store the RefreshToken and AccessToken
                            var refreshToken = new AlexaAuth.AlexaAuthRefreshToken({
                                token: body.refresh_token,
                                user: user
                            });
                            var expires = Math.round((body.expires_in - (new Date().getTime()))/1000);
                            var accessToken = new AlexaAuth.AlexaAuthAccessToken({
                                token: body.access_token,
                                user: user,
                                grant: grant,
                                expires: expires
                            });
                            var pSaveRefreshToken = new Promise((resolve, reject) => {
                                refreshToken.save(function(err) {
                                    if (!err) {resolve(refreshToken)}
                                    else {
                                        logger.log('error', "[Alexa Auth] Failed to save refreshToken for:" + user.username);
                                        reject(err)
                                    }
                                });
                            });
                            var pSaveAccessToken = new Promise((resolve, reject) => {
                                accessToken.save(function(err) {
                                    if (!err) {resolve(accessToken)}
                                    else {
                                        logger.log('error', "[Alexa Auth] Failed to save accessToken for:" + user.username)
                                        reject(err)
                                    }
                                });
                            });
                            Promise.all([pSaveRefreshToken, pSaveAccessToken]).then(([refresh, access]) => {
                                logger.log('verbose', "[Alexa Auth] Saved RefreshToken for user:" + user.username + ", token:" + JSON.stringify(refresh));
                                logger.log('verbose', "[Alexa Auth] Saved AccessToken for user:" + user.username + ", token:" + JSON.stringify(access));
                                callback(access);
                            }).catch(err => {
                                logger.log('error', "[Alexa Auth] requestAccessToken error:" + err);
                                callback(undefined);
                            });
                        }
                    }
                );
            }
            // User had grant code and refresh token, no (valid) access token
            else if (grant && refreshtoken && !accesstoken) { // Request new access token using refresh token
                logger.log('verbose', "[Alexa Auth] User:" + user.username + " has existing grant code and refresh token");
                request.post({
                    url: 'https://api.amazon.com/auth/o2/token',
                    form: {
                        grant_type : "refresh_token",
                        refresh_token: refresh.token,
                        client_id : client_id,
                        client_secret : client_secret 
                        }
                    },
                    function(err,res, body){
                        if (err) {
                            logger.log('error', "[Alexa Auth] Failed to request access token using grant code for user:" + user.username + ", error: " + err);
                            callback(undefined);
                        } else {
                            // Store the AccessToken
                            var expires = Math.round((body.expires_in - (new Date().getTime()))/1000);
                            var accessToken = new AlexaAuth.AlexaAuthAccessToken({
                                token: body.access_token,
                                user: user,
                                grant: grant,
                                expires: expires
                            });
                            var pSaveAccessToken = new Promise((resolve, reject) => {
                                accessToken.save(function(err) {
                                    if (!err) {resolve(accessToken)}
                                    else {
                                        logger.log('error', "[Alexa Auth] Failed to save accessToken for:" + user.username)
                                        reject(err)
                                    }
                                });
                            });
                            Promise.all([pSaveAccessToken]).then(([access]) => {
                                logger.log('verbose', "[Alexa Auth] Saved AccessToken for user:" + user.username + ", token:" + JSON.stringify(access));
                                callback(access);
                            }).catch(err => {
                                logger.log('error', "[Alexa Auth] requestAccessToken error:" + err);
                                callback(undefined);
                            });
                        }
                    }
                );
            }
            // User had grant code and refresh token, and valid access token
            else if (grant && refreshtoken && accesstoken) {
                logger.log('verbose', "[Alexa Auth] User:" + user.username + " has existing grant code, refresh token and valid access token");
                logger.log('verbose', "[Alexa Auth] Returned existing AccessToken for user:" + user.username + ", token:" + JSON.stringify(accesstoken));
                callback(accesstoken);
            }
            else { // Shouldn't get here!
                callback(undefined);
            }
        });
    }
    else {
        logger.log('warn', "[Alexa Auth] enableAlexaAuthorization is DISABLED");
        callback(undefined);
    }
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
module.exports.sendState = function sendState(token, stateUpdate) {
    // Going to need endpointId, messageId (it if exists), correlationToken (it if exists), AccessToken

    /* 
    Use the access_token value in the scope of messages to the Alexa event gateway. The endpoints are:
    > North America: https://api.amazonalexa.com/v3/events
    > Europe: https://api.eu.amazonalexa.com/v3/events
    > Far East: https://api.fe.amazonalexa.com/v3/events

Authorization token specified as an HTTP Authorization header and a bearer token in the scope of the message:

        POST api-amazonalexa.com
        Authorization: Bearer Atza|IQEBLjAsAhRmHjNgHpi0U-Dme37rR6CuUpSR...
        Content-Type: application/json
        {
            "context": {
                "properties": [ {
                "namespace": "Alexa.LockController",
                "name": "lockState",
                "value": "LOCKED",
                "timeOfSample": "2017-02-03T16:20:50.52Z",
                "uncertaintyInMilliseconds": 1000
                } ]
            },
            "event": {
                "header": {
                "namespace": "Alexa",
                "name": "Response",
                "payloadVersion": "3",
                "messageId": "5f8a426e-01e4-4cc9-8b79-65f8bd0fd8a4",
                "correlationToken": "dFMb0z+PgpgdDmluhJ1LddFvSqZ/jCc8ptlAKulUj90jSqg=="
                },
                "endpoint": {
                "scope": {
                    "type": "BearerToken",
                    "token": "Atza|IQEBLjAsAhRmHjNgHpi0U-Dme37rR6CuUpSR..."
                },
                "endpointId": "appliance-001"
                },
                "payload": {}
            }
        }

        if response is 403, as below remove all stored auth data
		/// function remove authdata

				HTTP/1.1 403 Forbidden
				Date: Wed, 07 Mar 2018 20:25:31 GMT
				Connection: close
					{
						"header": {
							"namespace": "System",
							"name": "Exception",
							"messageId": "90c3fc62-4b2d-460c-9c8b-77251f1698a0"
						},
						"payload": {
							"code": "SKILL_DISABLED_EXCEPTION",
							"description": "Skill is disabled. 3P needs to specifically identify that the skill is disabled by the customer so they can stop sending events for that customer"
						}
					}
        */
}

// Check user is actually enabled / account-linked for Alexa
module.exports.isAlexaUser = function isAlexaUser(username, callback) {
    const pUsers = Account.find({username: username });
	Promise.all([pUsers]).then(([users]) => {
        if (users){
			if (users[0].activeServices && users[0].activeServices.indexOf('Alexa') != -1) {
				callback(true);
			}
			else {
				callback(false);
			}
		}
	});
}