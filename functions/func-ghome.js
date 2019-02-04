///////////////////////////////////////////////////////////////////////////
// Depends
///////////////////////////////////////////////////////////////////////////
const request = require('request');
var Account = require('../models/account');
var logger = require('../config/logger');
const jwt = require('jsonwebtoken');
///////////////////////////////////////////////////////////////////////////
// Variables
///////////////////////////////////////////////////////////////////////////
var debug = (process.env.ALEXA_DEBUG || false);
// Google JWT OAuth =========================
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
// Google Home Sync =========================
var enableGoogleHomeSync = true;
if (!(process.env.HOMEGRAPH_APIKEY)){
	logger.log('warn',"[Core] No HOMEGRAPH_APIKEY environment variable supplied. New devices, removal or device changes will not show in users Google Home App without this");
	enableGoogleHomeSync = false;
}
else {
	var SYNC_API = "https://homegraph.googleapis.com/v1/devices:requestSync?key=" + process.env.HOMEGRAPH_APIKEY;
}
///////////////////////////////////////////////////////////////////////////
// Exports
///////////////////////////////////////////////////////////////////////////
// Call this from QUERY intent or reportstate API endpoint
module.exports.queryDeviceState = function queryDeviceState(device, callback) {
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
				if (trait = "action.devices.traits.Volume") {
					dev.currentVolume = device.state.volume;
					dev.isMuted = device.state.mute;
				}
			});
			// Retrun device state
			callback(dev);
	}
	else if (!device) {
		logger.log('warn', "[GHome Query API] queryDeviceState Device not specified");
		callback(undefined);
	}
}
// Check user is actually enabled / account-linked for Google Home
module.exports.isGhomeUser = function isGhomeUser(user, callback) {
	if (user.activeServices && user.activeServices.indexOf('Google') != -1) {
		//logger.log('verbose', "[State API] User: " + users[0].username + ", IS a Google Home-enabled user");
		callback(true);
	}
	else {
		//logger.log('verbose', "[State API] User: " + users[0].username + ", is NOT a Google Home-enabled user.");
		callback(false);
	}
}
// Send State Update
module.exports.sendState = function sendState(token, response) {
	if (reportState == true && token != undefined) {
		logger.log('verbose', "[State API] Sending HomeGraph State report:" + JSON.stringify(response));
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
					logger.log('verbose', "[State API] State report to HomeGraph successful!");
				}
				else {logger.log('verbose', "[State API] State report reponse code:" + res.statusCode)}
			}
		});
	}
}
// Get OAuth HomeGraph token
module.exports.requestToken2 = function requestToken2(keys, callback) {
	if (reportState == true) {
		var payload = {
				"iss": keys.client_email,
				"scope": "https://www.googleapis.com/auth/homegraph",
				"aud": "https://accounts.google.com/o/oauth2/token",
				"iat": new Date().getTime()/1000,
				"exp": new Date().getTime()/1000 + 3600,
		}
		var privKey = keys.private_key;
		var token = jwt.sign(payload, privKey, { algorithm: 'RS256'}); // Use jsonwebtoken to sign token
		request.post({
			url: 'https://accounts.google.com/o/oauth2/token',
			form: {
				grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
				assertion: token
				}
			},
			function(err,res, body){
				if (err) {
					callback(undefined);
				} else {
					callback(JSON.parse(body).access_token);
				}
			}
		);
	}
	else {callback(undefined)}
}
// GHome Request Sync, see: https://developers.google.com/actions/smarthome/request-sync 
module.exports.gHomeSync = function gHomeSync(userid){
    const pUsers = Account.findOne({_id:userid});
	Promise.all([pUsers]).then(([user]) => {
        if (user){
			if (user.activeServices && user.activeServices.indexOf('Google') != -1) {
				request(
					{
						headers: {
							"User-Agent": "request",
							"Referer": "https://" + process.env.WEB_HOSTNAME
						  },
						url: SYNC_API,
						method: "POST",
						json: {
							agentUserId: user._id
						}
					},
					function(err, resp, body) {
						if (!err) {
							logger.log('debug', "[GHome Sync Devices] Success for user:" + user.username + ", userid" + user._id);
						} else {
							logger.log('debug', "[GHome Sync Devices] Failure for user:" + user.username + ", error: " + err);
						}
					}
				);
			}
			else {
				logger.log('debug', "[GHome Sync Devices] Not sending Sync Request for user:" + user.username + ", user has not linked Google Account with bridge account");
			}
		}
	});
}
///////////////////////////////////////////////////////////////////////////
// Functions
///////////////////////////////////////////////////////////////////////////
// Convert Alexa Device Capabilities to Google Home-compatible
function gHomeReplaceCapability(capability) {
	// Limit supported traits, add new ones here
	if (capability == "PowerController"){return "action.devices.traits.OnOff"}
	else if(capability == "BrightnessController"){return "action.devices.traits.Brightness"}
	else if(capability == "ColorController" || capability == "ColorTemperatureController"){return "action.devices.traits.ColorSetting"}
	else if(capability == "ChannelController"){return "action.devices.traits.Channel"}
	else if(capability == "InputController"){return "action.devices.traits.InputSelector"} 
	//else if(capability == "LockController"){return "action.devices.traits.LockUnlock"} 
	else if (capability == "PlaybackController"){return "action.devices.traits.MediaState"}
	else if(capability == "SceneController"){return "action.devices.traits.Scene"}
	else if(capability == "Speaker"){return "action.devices.traits.Volume"} 
	else if(capability == "ThermostatController"){return "action.devices.traits.TemperatureSetting"}
	else {return "Not Supported"}
}
// Nested attribute/ element tester
function getSafe(fn) {
	try {
		return fn();
    } catch (e) {
        return undefined;
    }
}