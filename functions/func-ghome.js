// Request =======================
const request = require('request');
// ===============================
// Schema =======================
var Account = require('../models/account');
var oauthModels = require('../models/oauth');
var Devices = require('../models/devices');
var Topics = require('../models/topics');
var LostPassword = require('../models/lostPassword');
// ===============================
// Winston Logger ============================
var logger = require('../config/logger');
var debug = (process.env.ALEXA_DEBUG || false);
// ===========================================
// Google Auth JSON Web Token ================
const jwt = require('jsonwebtoken');
const ghomeJWT = process.env['GHOMEJWT'];
var reportState = false;
var keys;
if (!ghomeJWT) {
	logger.log('warn', "[GHome API] JSON Web Token not supplied via ghomeJWT environment variable. Google Home Report State disabled.")
}
else {
	reportState = true;
	keys = JSON.parse(ghomeJWT);
}
// ===========================================

// Call this from QUERY intent or reportstate API endpoint
module.exports.queryDeviceState = function queryDeviceState(device) {
	if (device) {
		var dev = {};
		// Create initial JSON object for device
		dev.online = true;
		// Add state response based upon device traits
		device.capabilities.forEach(function(capability){
			var trait = gHomeReplaceCapability(capability);
				// Limit supported traits, add new ones here once SYNC and gHomeReplaceCapability function updated
				if (trait == "action.devices.traits.Brightness"){
					dev.brightness = device.state.brightness;
				}
				if (trait == "action.devices.traits.ColorSetting") {
					if (!dev.hasOwnProperty('on')){
						dev.on = device.state.power.toLowerCase();
					}
					if (device.capabilities.indexOf('ColorController') > -1 ){
						dev.color = {
							"spectrumHsv": {
								"hue": device.state.colorHue,
								"saturation": device.state.colorSaturation,
								"value": device.state.colorBrightness
								}
						}
					}
					if (device.capabilities.indexOf('ColorTemperatureController') > -1){
						var hasColorElement = getSafe(() => dev.color);
						if (hasColorElement != undefined) {dev.color.temperatureK = device.state.colorTemperature}
						else {
							dev.color = {
								"temperatureK" : device.state.colorTemperature
							}
						}
					}
				}
				if (trait == "action.devices.traits.OnOff") {
					if (device.state.power.toLowerCase() == 'on') {
						dev.on = true;
					}
					else {
						dev.on = false;
					}
					
				}
				// if (trait == "action.devices.traits.Scene") {} // Only requires 'online' which is set above
				if (trait == "action.devices.traits.TemperatureSetting") {
					dev.thermostatMode = device.state.thermostatMode.toLowerCase();
					dev.thermostatTemperatureSetpoint = device.state.thermostatSetPoint;
					if (device.state.hasOwnProperty('temperature')) {
						dev.thermostatTemperatureAmbient = device.state.temperature;
					}
				}
			});
			// Retrun device state
			return dev;
	}
	else if (!device) {
		logger.log('warn', "[GHome Query API] queryDeviceState Device not specified");
		return {message: "Device not found"};
	}
}

// Convert Alexa Device Capabilities to Google Home-compatible
function gHomeReplaceCapability(capability) {
	// Limit supported traits, add new ones here
	if(capability == "PowerController") {return "action.devices.traits.OnOff"}
	else if(capability == "BrightnessController")  {return "action.devices.traits.Brightness"}
	else if(capability == "ColorController" || capability == "ColorTemperatureController"){return "action.devices.traits.ColorSetting"}
	else if(capability == "SceneController") {return "action.devices.traits.Scene"}
	else if(capability == "ThermostatController")  {return "action.devices.traits.TemperatureSetting"}
	else {return "Not Supported"}
}

// GHome HomeGraph Token Request
module.exports.requestToken = function requestToken(keys) {
	logger.log('verbose', "[State API] Ghome JWT requesting OAuth token");
	if (reportState == true) {
		var payload = {
				"iss": keys.client_email,
				"scope": "https://www.googleapis.com/auth/homegraph",
				"aud": "https://accounts.google.com/o/oauth2/token",
				"iat": new Date().getTime()/1000,
				"exp": new Date().getTime()/1000 + 3600,
		}
		// Use jsonwebtoken to sign token
		// Sign token: https://cloud.google.com/endpoints/docs/openapi/service-account-authentication#using_jwt_signed_by_service_account
		var privKey = keys.private_key;
		var token = jwt.sign(payload, privKey, { algorithm: 'RS256'});
		// Need submit token using: application/x-www-form-urlencoded
		// Use form: https://www.npmjs.com/package/request#forms
		// Also include grant_type in form data : urn:ietf:params:oauth:grant-type:jwt-bearer
		request.post({
			url: 'https://accounts.google.com/o/oauth2/token',
			form: {
				grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
				assertion: token
				}
			},
			function(err,res, body){
				if (err) {
					return undefined;
				} else {
					return JSON.parse(body).access_token;
				}
			}
		);
	}
}

// Check user is actually enabled / account-linked for Google Home
module.exports.isGhomeUser = function isGhomeUser(username) {
    // Need device, user and whether user has grantcodes for GHome
    const pGHomeOauthApplication = oauthModels.Application.findOne({domains: "oauth-redirect.googleusercontent.com" });
    const pUsers = Account.find({username: username });
    Promise.all([pGHomeOauthApplication,pUsers]).then(([gHomeService, users]) => {
        if (gHomeService && users){
            const pCountGrantCode = oauthModels.GrantCode.countDocuments({user: users[0]._id, application: gHomeService._id});
            Promise.all([pCountGrantCode]).then(([countGrants]) => {
                if (countGrants && countGrants > 0) {
                    logger.log('verbose', "[State API] User: " + users[0].username + ", IS a Google Home-enabled user");
                    return true;
                }
                else {
                    logger.log('verbose', "[State API] User: " + users[0].username + ", is NOT a Google Home-enabled user.");
                    return false;
                }
            });
        }
});
}

// Send State Update
module.exports.sendState = function sendState(token, response) {
    request.post({
        url: 'https://homegraph.googleapis.com/v1/devices:reportStateAndNotification',
            headers:{
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + token,
                'X-GFE-SSL': 'yes'
            },
            json: response
    }, function(err,res, body){
		if (err) {
			logger.log('warn', "[State API] State report to HomeGraph failed");
		}
		else {
			if (res.statusCode == 200) {
				logger.log('verbose', "[State API] State report to HomeGraph failed");
			}
			else {logger.log('verbose', "[State API] State report reponse code:" + res.statusCode)}
		}
	});
}