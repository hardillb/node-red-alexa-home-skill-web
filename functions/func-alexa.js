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
if (process.env.ALEXA_CLIENTID != undefined && process.env.ALEXA_CLIENTSECRET != undefined) {
    logger.log('warn', "[AlexaAuth API] ALEXA_CLIENTID and ALEXA_CLIENTSECRET environment variables undefined, state reporting disabled!")
    var client_id = process.env.ALEXA_CLIENTID;
    var client_secret = process.env.ALEXA_CLIENTSECRET;
    enableAlexaAuthorization = true;
}
///////////////////////////////////////////////////////////////////////////
// Exports
///////////////////////////////////////////////////////////////////////////
// Store GrantCode
module.exports.saveGrant = function saveGrant(user, grantcode, callback){
    AlexaAuth.AlexaAuthGrantCode.findOne({user: user},function(error,grant){
        if (!grant && !error) {
            // Create and store the GrantCode
            var grant = new AlexaAuth.AlexaAuthGrantCode({
                user: user,
                code: grantcode
            });
            grant.save(function(err) {
                if (!err) {
                    callback(grant)
                }
                else {callback(err)}
            });
        }
        else if (grant) {
            logger.log('verbose', "[AlexaAuth API] User already has Alexa/Authorization GrantCode")
        }
        else if (error) {
            logger.log('error', "[AlexaAuth API] Error trying to find Alexa/Authorization GrantCode. error:" + error)
        }
    });
}
// Use stored GrantCode to request access token and refresh token
module.exports.requestAccessToken = function requestAccessToken(user, callback) {
    if (enableAlexaAuthorization == true) {
        var now = (new Date().getTime())
        var pGrantCodes = AlexaAuth.AlexaAuthGrantCode.findOne({user: user});
        var pRefreshTokens = AlexaAuth.AlexaAuthRefreshToken.findOne({user: user});
        var pAccessTokens = AlexaAuth.AlexaAuthAccessTokens.findOne({user: user, expires: {$gt: now}});
        Promise.all([pGrantCodes, pRefreshTokens, pAccessTokens]).then(([grant, refreshtoken, accesstoken]) => {
            // User had grant code only, no refresh token, no (valid) access token
            if (grant && !refreshtoken && !accesstoken) { // Request new access token using grant code
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
                            //callback(undefined);
                        } else {
                            // Store the RefreshToken and AccessToken
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

                            refreshToken.save(function(err) {
                                if (!err) {
                                    //callback(grant)
                                }
                                else {
                                    //callback(err)
                                }
                            });

                            // Store the AccessToken
                            accessToken.save(function(err) {
                                if (!err) {
                                    //callback(grant)
                                }
                                else {
                                    //callback(err)
                                }
                            });

                        }
                    }
                );
            }
            // User had grant code and refresh token, no (valid) access token
            else if (grant && refreshtoken && !accesstoken) { // Request new access token using refresh token
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
                            //callback(undefined);
                        } else {
                            // Store the AccessToken
                            var expires = Math.round((body.expires_in - (new Date().getTime()))/1000);
                            var accessToken = new AlexaAuth.AlexaAuthAccessToken({
                                token: body.access_token,
                                user: user,
                                grant: grant,
                                expires: expires
                            });
                            accessToken.save(function(err) {
                                if (!err) {
                                    //callback(grant)
                                }
                                else {
                                    //callback(err)
                                }
                            });
                        }
                    }
                );
            }
            // User had grant code and refresh token, and valid access token
            else if (grant && refreshtoken && accesstoken) {
                callback(accesstoken)
            }
            else {
                // ??? Shouldn;t get here
            }
        });
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