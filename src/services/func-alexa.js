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
                else {
                    return {status: true};
                }
            }
            else {
                logger.log('debug', "[Alexa Command] Device: " + req.body.directive.endpoint.endpointId + " does not have attributes.colorTemperatureRange defined");
                return {status: true};
            }
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
                else {
                    return {status: true};
                }
            }
            else {
                logger.log('debug', "[Alexa Command] Device: " + req.body.directive.endpoint.endpointId + " does not have attributes.temperatureRange defined");
                return {status: true};
            }
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
const buildCommandResponseAsync = async(device, req) => {
    try {
        // Convert "model" object class to JSON object
        var deviceJSON = JSON.parse(JSON.stringify(device));
        var endpointId = req.body.directive.endpoint.endpointId;
        var messageId = req.body.directive.header.messageId;
        var oauth_id = req.body.directive.endpoint.scope.token;
        var correlationToken = req.body.directive.header.correlationToken;
        var dt = new Date();
        var name = req.body.directive.header.name;
        var namespace = req.body.directive.header.namespace;

        // Build Response Header
        var header = {
            "namespace": "Alexa",
            "name": "Response",
            "payloadVersion": "3",
            "messageId": messageId + "-R",
            "correlationToken": correlationToken
        }
        // Build Default Endpoint Response
        var endpoint = {
            "scope": {
                "type": "BearerToken",
                "token": oauth_id
            },
            "endpointId": endpointId
        }
        // Build command/ device-specific response information
        // Build Brightness Controller Response Context
        if (namespace == "Alexa.BrightnessController" && (name == "AdjustBrightness" || name == "SetBrightness")) {
            if (name == "AdjustBrightness") {
                var brightness;
                if (req.body.directive.payload.brightnessDelta < 0) {
                    brightness = req.body.directive.payload.brightnessDelta + 100;
                }
                else {
                    brightness = req.body.directive.payload.brightnessDelta;
                }
                // Return Percentage Delta (NOT in-line with spec)
                var contextResult = {
                    "properties": [{
                        "namespace" : "Alexa.BrightnessController",
                        "name": "brightness",
                        "value": brightness,
                        "timeOfSample": dt.toISOString(),
                        "uncertaintyInMilliseconds": 50
                    }]
                };

            }
            if (name == "SetBrightness") {
                // Return Percentage
                var contextResult = {
                    "properties": [{
                        "namespace" : "Alexa.BrightnessController",
                        "name": "brightness",
                        "value": req.body.directive.payload.brightness,
                        "timeOfSample": dt.toISOString(),
                        "uncertaintyInMilliseconds": 50
                    }]
                }
            };
        }
        // Build Channel Controller Response Context
        else if (namespace == "Alexa.ChannelController") {
            if (name == "ChangeChannel") {
                if (req.body.directive.payload.channel.hasOwnProperty('number')) {
                    var contextResult = {
                    "properties": [
                        {
                        "namespace": "Alexa.ChannelController",
                        "name": "channel",
                        "value": {
                            "number": req.body.directive.payload.channel.number
                        },
                        "timeOfSample": dt.toISOString(),
                        "uncertaintyInMilliseconds": 50
                        }
                    ]}
                }
                else if (req.body.directive.payload.channel.hasOwnProperty('callSign')) {
                    var contextResult = {
                        "properties": [
                            {
                            "namespace": "Alexa.ChannelController",
                            "name": "channel",
                            "value": {
                                "callSign": req.body.directive.payload.channel.callSign
                            },
                            "timeOfSample": dt.toISOString(),
                            "uncertaintyInMilliseconds": 50
                            }
                        ]}
                }
            }
        }
        // ColorController
        else if (namespace == "Alexa.ColorController") {
            var contextResult = {
                "properties": [{
                    "namespace" : "Alexa.ColorController",
                    "name": "color",
                    "value": {
                        "hue": req.body.directive.payload.color.hue,
                        "saturation": req.body.directive.payload.color.saturation,
                        "brightness": req.body.directive.payload.color.brightness
                    },
                    "timeOfSample": dt.toISOString(),
                    "uncertaintyInMilliseconds": 50
                }]
            };
        }
        // Build ColorTemperatureController Response Context
        else if (namespace == "Alexa.ColorTemperatureController") {
            var strPayload = req.body.directive.payload.colorTemperatureInKelvin;
            var colorTemp;
            if (typeof strPayload != 'number') {
                if (strPayload == "warm" || strPayload == "warm white") {colorTemp = 2200};
                if (strPayload == "incandescent" || strPayload == "soft white") {colorTemp = 2700};
                if (strPayload == "white") {colorTemp = 4000};
                if (strPayload == "daylight" || strPayload == "daylight white") {colorTemp = 5500};
                if (strPayload == "cool" || strPayload == "cool white") {colorTemp = 7000};
            }
            else {
                colorTemp = req.body.directive.payload.colorTemperatureInKelvin;
            }
            var contextResult = {
                "properties": [{
                    "namespace" : "Alexa.ColorTemperatureController",
                    "name": "colorTemperatureInKelvin",
                    "value": colorTemp,
                    "timeOfSample": dt.toISOString(),
                    "uncertaintyInMilliseconds": 50
                }]
            }
        }
        // Build Input Controller Response Context
        else if (namespace == "Alexa.InputController") {
            var contextResult = {
                "properties": [{
                    "namespace" : "Alexa.InputController",
                    "name": "input",
                    "value": req.body.directive.payload.input,
                    "timeOfSample": dt.toISOString(),
                    "uncertaintyInMilliseconds": 50
                }]
            }
            endpoint = {
                "endpointId": endpointId
            }
        }
        // Build Lock Controller Response Context - SetThermostatMode
        else if (namespace == "Alexa.LockController") {
            var lockState;
            if (name == "Lock") {lockState = "LOCKED"};
            if (name == "Unlock") {lockState = "UNLOCKED"};
            var contextResult = {
                "properties": [{
                "namespace": "Alexa.LockController",
                "name": "lockState",
                "value": lockState,
                "timeOfSample": dt.toISOString(),
                "uncertaintyInMilliseconds": 500
                }]
            };
        }
        // Build Mode Controller Response Context - Interior and Exterior Blinds
        // if (namespace == "Alexa.ModeController" && (deviceJSON.displayCategories.indexOf('INTERIOR_BLIND') > -1 || deviceJSON.displayCategories.indexOf('EXTERIOR_BLIND') > -1)) {
        // 	if (name == "SetMode") {
        // 		var contextResult = {
        // 			"properties": [{
        // 				"namespace": "Alexa.ModeController",
        // 				"instance" : "Blinds.Position",
        // 				"name": "mode",
        // 				"value": req.body.directive.payload.percentage,
        // 				"timeOfSample": dt.toISOString(),
        // 				"uncertaintyInMilliseconds": 500
        // 			}]
        // 		};
        // 	}
        // 	if (name == "AdjustMode ") {
        // 		// Unsupported for Interior/ Exterior Blinds
        // 		// Send INVALID_DIRECTIVE : https://developer.amazon.com/docs/device-apis/alexa-errorresponse.html#error-types
        // 	}
        // }
        // Build PercentageController Response Context
        else if (namespace == "Alexa.PercentageController") {
            if (name == "SetPercentage") {
                var contextResult = {
                    "properties": [{
                        "namespace": "Alexa.PercentageController",
                        "name": "percentage",
                        "value": req.body.directive.payload.percentage,
                        "timeOfSample": dt.toISOString(),
                        "uncertaintyInMilliseconds": 500
                    }]
                };
            }
            if (name == "AdjustPercentage") {
                var percentage;
                var hasPercentage = getSafe(() => deviceJSON.state.percentage);
                if (hasPercentage != undefined) {
                    if (deviceJSON.state.percentage + req.body.directive.payload.percentageDelta > 100) {percentage = 100}
                    else if (deviceJSON.state.percentage - req.body.directive.payload.percentageDelta < 0) {percentage = 0}
                    else {percentage = deviceJSON.state.percentage + req.body.directive.payload.percentageDelta}
                    var contextResult = {
                        "properties": [{
                            "namespace": "Alexa.PercentageController",
                            "name": "percentage",
                            "value": percentage,
                            "timeOfSample": dt.toISOString(),
                            "uncertaintyInMilliseconds": 500
                            }]
                        };
                    }
            }
        }
        // Build PlaybackController Response Context
        else if (namespace == "Alexa.PlaybackController") {
            var contextResult = {
                "properties": []
            };
        }
        // Build PowerController Response Context
        else if (namespace == "Alexa.PowerController") {
            if (name == "TurnOn") {var newState = "ON"};
            if (name == "TurnOff") {var newState = "OFF"};
            var contextResult = {
                "properties": [{
                    "namespace": "Alexa.PowerController",
                    "name": "powerState",
                    "value": newState,
                    "timeOfSample": dt.toISOString(),
                    "uncertaintyInMilliseconds": 50
                }]
            };
        }
        // Build RangeController Interior/ Exterior Blind Response Context
        else if (namespace == "Alexa.RangeController" && (deviceJSON.displayCategories.indexOf('INTERIOR_BLIND') > -1 || deviceJSON.displayCategories.indexOf('EXTERIOR_BLIND') > -1)) {
            if (name == "SetRangeValue") {
                var contextResult = {
                    "properties": [
                        {
                        "namespace": "Alexa.RangeController",
                        "instance" : "Blind.Lift",
                        "name": "rangeValue",
                        "value":  req.body.directive.payload.rangeValue,
                        "timeOfSample": dt.toISOString(),
                        "uncertaintyInMilliseconds": 50
                        }
                    ]}
            }
            else if (name == "AdjustRangeValue") {
                var rangeValue;
                var hasrangeValue = getSafe(() => deviceJSON.state.rangeValue);
                if (hasrangeValue != undefined) {
                    if (deviceJSON.state.rangeValue + req.body.directive.payload.rangeValueDelta > 100) {rangeValue = 100}
                    else if (deviceJSON.state.rangeValue + req.body.directive.payload.rangeValueDelta < 0) {rangeValue = 0}
                    else {rangeValue = deviceJSON.state.rangeValue + req.body.directive.payload.rangeValueDelta}
                    var contextResult = {
                        "properties": [{
                            "namespace": "Alexa.RangeController",
                            "instance" : "Blind.Lift",
                            "name": "rangeValue",
                            "value":  rangeValue,
                            "timeOfSample": dt.toISOString(),
                            "uncertaintyInMilliseconds": 50
                            }]
                        };
                    }
            }
        }
        // Build Generic RangeController Response Context
        else if (namespace == "Alexa.RangeController") {
            if (name == "SetRangeValue") {
                var contextResult = {
                    "properties": [
                        {
                        "namespace": "Alexa.RangeController",
                        "instance" : "NodeRed.Fan.Speed",
                        "name": "rangeValue",
                        "value":  req.body.directive.payload.rangeValue,
                        "timeOfSample": dt.toISOString(),
                        "uncertaintyInMilliseconds": 50
                        }
                    ]}
            }
            else if (name == "AdjustRangeValue") {
                var rangeValue;
                var hasrangeValue = getSafe(() => deviceJSON.state.rangeValue);
                if (hasrangeValue != undefined) {
                    if (deviceJSON.state.rangeValue + req.body.directive.payload.rangeValueDelta > 10) {rangeValue = 10}
                    else if (deviceJSON.state.rangeValue + req.body.directive.payload.rangeValueDelta < 1) {rangeValue = 1}
                    else {rangeValue = deviceJSON.state.rangeValue + req.body.directive.payload.rangeValueDelta}
                    var contextResult = {
                        "properties": [{
                            "namespace": "Alexa.RangeController",
                            "instance" : "NodeRed.Fan.Speed",
                            "name": "rangeValue",
                            "value":  rangeValue,
                            "timeOfSample": dt.toISOString(),
                            "uncertaintyInMilliseconds": 50
                            }]
                        };
                    }
            }
        }
        // Build Scene Controller Activation Started Event
        else if (namespace == "Alexa.SceneController") {
            header.namespace = "Alexa.SceneController";
            header.name = "ActivationStarted";
            var contextResult = {};
            var payload = {
                    "cause" : {
                        "type" : "VOICE_INTERACTION"
                        },
                    "timestamp": dt.toISOString()
                    };
        }
        // Build Speaker Response Context
        else if (namespace == "Alexa.Speaker") {
            if (name == "SetVolume") {
                var contextResult = {
                    "properties": [
                        {
                        "namespace": "Alexa.Speaker",
                        "name": "volume",
                        "value":  req.body.directive.payload.volume,
                        "timeOfSample": dt.toISOString(),
                        "uncertaintyInMilliseconds": 50
                        }
                    ]}
                }
            else if (name == "SetMute") {
                var contextResult = {
                    "properties": [
                        {
                            "namespace": "Alexa.Speaker",
                            "name": "muted",
                            "value": req.body.directive.payload.mute,
                            "timeOfSample": dt.toISOString(),
                            "uncertaintyInMilliseconds": 50
                        }
                    ]}
            }
            else {
                var contextResult = {
                    "properties": []
                };
            }
        }
        // Build StepSpeaker Response Context
        else if (namespace == "Alexa.StepSpeaker") {
            var contextResult = {
                "properties": []
                };
        }
        //Build Thermostat Controller Response Context - AdjustTargetTemperature/ SetTargetTemperature
        else if (namespace == "Alexa.ThermostatController" && (name == "AdjustTargetTemperature" || name == "SetTargetTemperature")) {
            // Check existing attributes
            var hasTemperatureScale  = getSafe(() => deviceJSON.attributes.temperatureScale);
            var hasThermostatSetPoint = getSafe(() => deviceJSON.state.thermostatSetPoint);
            var hasThermostatModes = getSafe(() => deviceJSON.attributes.thermostatModes);
            // Create placeholder variables
            var targetTemp, scale, thermostatMode;
            // Adjust command, will be +/- delta
            if (name == "AdjustTargetTemperature") {
                // Use existing thermostatSetPoint to establish new thermostatSetPoint to feedback in response
                if (hasThermostatSetPoint != undefined){targetTemp = deviceJSON.state.thermostatSetPoint + req.body.directive.payload.targetSetpointDelta.value}
                // No existing thermostatSetPoint value, use delta as new Set Point to feedback in response
                else {targetTemp = req.body.directive.payload.targetSetpointDelta.value}
                // Use existing temperatureScale value
                if (hasTemperatureScale != undefined){scale = deviceJSON.attributes.temperatureScale}
                // No existing temperatureScale value, use scale supplied
                else {scale = req.body.directive.payload.targetSetpointDelta.scale}
            }
            // Specific temperature supplied in command, use command-supplied fields
            else if (name == "SetTargetTemperature") {
                targetTemp = req.body.directive.payload.targetSetpoint.value;
                scale = req.body.directive.payload.targetSetpoint.scale;
            }
            // Mode only, send existing value where they exist
            else if (name == "SetThermostatMode") {
                if (hasThermostatSetPoint != undefined) targetTemp = deviceJSON.state.thermostatSetPoint;
                if (hasTemperatureScale != undefined) scale = deviceJSON.attributes.temperatureScale;
                // Use command-supplied thermostat mode
                thermostatMode = req.body.directive.payload.thermostatMode.value;
            }
            // Workout new thermostatMode
            if (hasThermostatModes != undefined && thermostatMode == undefined){
                thermostatMode = deviceJSON.state.thermostatMode;
            }
            else {
                thermostatMode = "HEAT";
            }
            // Create response targetSetpoint value
            var targetSetPointValue = {
                "value": targetTemp,
                "scale": scale
            };
            // Create response context object
            var contextResult = {
                "properties": [{
                    "namespace": "Alexa.ThermostatController",
                    "name": "targetSetpoint",
                    "value": targetSetPointValue,
                    "timeOfSample": dt.toISOString(),
                    "uncertaintyInMilliseconds": 50
                },
                {
                    "namespace": "Alexa.ThermostatController",
                    "name": "thermostatMode",
                    "value": thermostatMode,
                    "timeOfSample": dt.toISOString(),
                    "uncertaintyInMilliseconds": 50
                },
                {
                    "namespace": "Alexa.EndpointHealth",
                    "name": "connectivity",
                    "value": {
                        "value": "OK"
                    },
                    "timeOfSample": dt.toISOString(),
                    "uncertaintyInMilliseconds": 50
                }]
            };
        }
        // Build Thermostat Controller Response Context - SetThermostatMode
        else if (namespace == "Alexa.ThermostatController" && name == "SetThermostatMode") {
            var contextResult = {
                "properties": [{
                "namespace": "Alexa.ThermostatController",
                "name": "thermostatMode",
                "value": req.body.directive.payload.thermostatMode.value,
                "timeOfSample": dt.toISOString(),
                "uncertaintyInMilliseconds": 500
            }]
            };
        }
        /////////////////////////////
        // Form Final Response, use default format (payload is empty)
        /////////////////////////////
        if (namespace != "Alexa.SceneController"){
            // Compile Final Response Message
            var response = {
                context: contextResult,
                event: {
                header: header,
                endpoint: endpoint,
                payload: {}
                }
            };
        }
        // Form Final Response, SceneController Specific Event
        else {
            var response = {
                context: contextResult,
                event: {
                header: header,
                endpoint: endpoint,
                payload: payload
                }
            };
        }
        // Return response object
        return response;
    }
    catch(e){
        logger.log('error', "[Alexa Command] Response generation failed, error: " + e.stack);
        return undefined;
    }
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
    validateCommandAsync,
    buildCommandResponseAsync
}