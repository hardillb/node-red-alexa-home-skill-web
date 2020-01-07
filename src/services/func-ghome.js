///////////////////////////////////////////////////////////////////////////
// Depends
///////////////////////////////////////////////////////////////////////////
const axios = require('axios');
const querystring = require('querystring');
var Account = require('../models/account');
var logger = require('../loaders/logger');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const util = require("util");
const removeUserServices = require('../services/func-services').removeUserServices;
///////////////////////////////////////////////////////////////////////////
// Variables
///////////////////////////////////////////////////////////////////////////
const ghomeJWT_file = 'ghomejwt.json';
const readFile = util.promisify(fs.readFile);
//var debug = (process.env.ALEXA_DEBUG || false);

// Google JWT OAuth =========================
var reportState = false;
var keys; // variable used to store JWT for Out-of-Band State Reporting to Google Home Graph API

const readFileAsync = async() => {
	var data = await readFile(ghomeJWT_file, 'utf8');
	return data;
}

readFileAsync()
	.then(result => {
		// Read JSON file was successful, enable GHome HomeGraph state reporting
		reportState = true;
		keys = JSON.parse(result);
	})
	.catch(err => {
		logger.log('warn', "[GHome API] Error reading GHome HomeGraph API JSON file, Report State disabled. Error message: " + err );
	})

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

const gHomeSyncAsync = async(userId) => {
	try {
		var user = await Account.findOne({_id:userId});
		if (user.activeServices && user.activeServices.indexOf('Google') != -1) {
			// POST SYNC Update to Google Home
			var response = await axios({
				method: 'post',
				url: SYNC_API,
				data: {agentUserId: user._id},
				headers: {
					"User-Agent": "request",
					"Referer": "https://" + process.env.WEB_HOSTNAME
				}
			});
			logger.log('verbose', "[GHome Sync Devices] Success for user: " + user.username + ", userId" + user._id);
		}
	}
	catch(e) {
		logger.log('error', "[GHome Sync Devices] Failure for user: " + user.username + ", error: " + e.stack);
	}
}

const requestToken2Async = async(keys) => {
	try {
		if (reportState == true) {
			// Build request
			var payload = {
				"iss": keys.client_email,
				"scope": "https://www.googleapis.com/auth/homegraph",
				"aud": "https://accounts.google.com/o/oauth2/token",
				"iat": new Date().getTime()/1000,
				"exp": new Date().getTime()/1000 + 3600,
			}
			var privKey = keys.private_key;
			// Use jsonwebtoken to sign token
			var token = jwt.sign(payload, privKey, { algorithm: 'RS256'});
			// Compose form data
			var formData = {
				grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
				assertion: token
			}
			// POST form data to request access token from Google Auth Service
			var response = await axios({
				method: 'post',
				url: 'https://accounts.google.com/o/oauth2/token',
				data: querystring.stringify(formData),
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded'
				}
			});
			// Success, return token
			if (response.status == 200) {
				logger.log('verbose', "[Google Home Token Request] Successfully requested token, response: " + JSON.stringify(response.data.access_token));
				return response.data.access_token;
			}
			// Failure, return undefined
			else {
				logger.log('error', "[Google Home Token Request] Failed to request token, response code: " + response.status);
				return undefined;
			}
		}
	}
	catch(e) {
		logger.log('error', "[Google Home Token Request] Failed to request token, error: " + e.stack);
		return undefined;
	}
}


const sendStateAsync = async(token, response, username) => {
	try {
		if (reportState == true && token != undefined) {
			// POST state report to Home Graph API
			var response = await axios({
				method: 'post',
				url: 'https://homegraph.googleapis.com/v1/devices:reportStateAndNotification',
				data: response,
				headers: {
					'Content-Type': 'application/json',
					'Authorization': 'Bearer ' + token,
					'X-GFE-SSL': 'yes'
				}
			});
			if (response.status == 200) {
				logger.log('verbose', "[Google Report State] Successfully sent GHome HomeGraph state report for user: " + username);
			}
		}
	}
	catch(e) {
		// User has likely disabled Google Home link with service
		if (e.response && e.response.data && e.response.status) {
			logger.log('warn', "[Google Send State] Failed to send change report for user: " + username + ", error response: " + JSON.stringify(e.response.data));
			// Remove 'Google' from users' active services
			if (e.response.status == 404) removeUserServices(username, "Google");
		}
		else {
			logger.log('error', "[Google Report State] Failed to report state for user: " + username + ", error: " + e.stack);
		}
	}
}

// Call this from QUERY intent or reportstate API endpoint
const queryDeviceStateAsync = async(device) => {
	try {
		var dev = {};
		// Create initial JSON object for device
		dev.online = true;
		// Convert Alexa Device Types to Google Home-compatible
		var deviceType = await gHomeReplaceType(device.displayCategories);
		// Add state response based upon device traits
		for (let capability of device.capabilities){
			var trait = await gHomeReplaceCapability(capability, deviceType);
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
			if (trait == "action.devices.traits.FanSpeed") {
				dev.currentFanSpeedSetting = "S" + device.state.rangeValue.toString();
			}
			if (trait == "action.devices.traits.LockUnlock") {
				if (device.state.lock.toLowerCase() == 'locked') {
					dev.isLocked = true;
				}
				else {
					dev.isLocked = false;
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
			if (trait == "action.devices.traits.OpenClose") {
				dev.openPercent = device.state.rangeValue;
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
		}
		// Return device state
		return dev;
	}
	catch(e) {
		logger.log('warn', "[GHome Query API] queryDeviceState error: " + e.stack);
		return undefined;
	}
}



const validateCommandAsync = async(command, commandDevice, dbDevice, req) => {
	try {
		// Get command parameters
		var params = command.execution[0].params;
		// Handle Thermostat valueOutOfRange
		if (command.execution[0].command == "action.devices.commands.ThermostatTemperatureSetpoint") {
			var hasTemperatureMax = getSafe(() => dbDevice.attributes.temperatureRange.temperatureMax);
			var hasTemperatureMin = getSafe(() => dbDevice.attributes.temperatureRange.temperatureMin);
			if (hasTemperatureMin != undefined && hasTemperatureMax != undefined) {
				var temperatureMin = dbDevice.attributes.temperatureRange.temperatureMin;
				var temperatureMax = dbDevice.attributes.temperatureRange.temperatureMax;
				logger.log('debug', "[GHome Validation] Checking requested setpoint: " + params.thermostatTemperatureSetpoint + " , against temperatureRange, temperatureMin:" + temperatureMin + ", temperatureMax:" + temperatureMax);
				if (params.thermostatTemperatureSetpoint > temperatureMax || params.thermostatTemperatureSetpoint < temperatureMin){
					// Build valueOutOfRange error response
					logger.log('warn', "[GHome Validation] Temperature valueOutOfRange error for endpointId:" + commandDevice.id);
					// Global error response
					var errResponse = {
						"requestId": req.body.requestId,
						"payload": {
							"errorCode": "valueOutOfRange"
						}
					}
					logger.log('debug', "[GHome Validation] valueOutOfRange error response:" + JSON.stringify(errResponse));
					return {status: false, response: errResponse};
				}
			}
		}
		// Handle Color Temperature valueOutOfRange
		if (command.execution[0].command == "action.devices.commands.ColorAbsolute") {
			var hasTemperatureMaxK = getSafe(() => dbDevice.attributes.colorTemperatureRange.temperatureMaxK);
			var hasTemperatureMinK = getSafe(() => dbDevice.attributes.colorTemperatureRange.temperatureMinK);
			if (hasTemperatureMinK != undefined && hasTemperatureMaxK != undefined) {
				var temperatureMinK = dbDevice.attributes.colorTemperatureRange.temperatureMinK;
				var temperatureMaxK = dbDevice.attributes.colorTemperatureRange.temperatureMaxK;
				logger.log('debug', "[GHome Validation] Checking requested setpoint: " + params.color.temperature + " , against temperatureRange, temperatureMin:" + temperatureMinK + ", temperatureMax:" + temperatureMaxK);
				if (params.color.temperature > temperatureMaxK || params.color.temperature < temperatureMinK){
					// Build valueOutOfRange error response
					logger.log('warn', "[GHome Validation] valueOutOfRange error for endpointId:" + commandDevice.id);
					// Global error response
					var errResponse = {
						"requestId": req.body.requestId,
						"payload": {
							"errorCode": "valueOutOfRange"
						}
					}
					logger.log('debug', "[GHome Validation] Color Temperature valueOutOfRange error response:" + JSON.stringify(errResponse));
					return {status: false, response: errResponse};
				}
			}
		}
		// Handle 2FA requirement
		var hasRequire2FA = getSafe(() => dbDevice.attributes.require2FA);
		if (hasRequire2FA == true) {
			var hasChallengeType = getSafe(() => dbDevice.attributes.type2FA); // check device for 2FA challenge type
			var hasChallengePin = getSafe(() => command.execution[0].challenge.pin); // check request itself for pin
			// PIN Required, NO pin supplied
			if (hasChallengeType == "pin" && hasChallengePin == undefined){
				logger.log('warn', "[GHome Validation] pinNeeded but not supplied for command against endpointId:" + commandDevice.id);
				var errResponse = {
					requestId: req.body.requestId,
					payload: {
						commands: [{
							ids: [commandDevice.id.toString()],
							status: "ERROR",
							errorCode: "challengeNeeded",
							challengeNeeded : {
								type: "pinNeeded"
							}
						}]
					}
				};
				logger.log('debug', "[GHome Validation] Color Temperature valueOutOfRange error response:" + JSON.stringify(errResponse));
				return {status: false, response: errResponse};
			}
			// PIN required, wrong PIN
			else if (hasChallengeType == "pin" && hasChallengePin != dbDevice.attributes.pin){
				logger.log('warn', "[GHome Validation] wrong pin supplied for command against endpointId:" + commandDevice.id);
				var errResponse = {
					requestId: req.body.requestId,
					payload: {
						commands: [{
							ids: [commandDevice.id.toString()],
							status: "ERROR",
							errorCode: "challengeNeeded",
							challengeNeeded : {
								type: "challengeFailedPinNeeded"
							}
						}]
					}
				};
				logger.log('debug', "[GHome Validation] Color Temperature valueOutOfRange error response:" + JSON.stringify(errResponse));
				return {status: false, response: errResponse};
			}
		}
		// No matches against defined validation rules, return true
		return {status: true};
	}
	catch(e){
        logger.log('error', "[Google Command] Validation of command failed, error: " + e.stack);
        return {status: false, response : undefined}
	}
}

// Convert Alexa Device Capabilities to Google Home-compatible
const gHomeReplaceCapability = async(capability, type) => {
	// Generic mappings - capabilities, limited to GHome supported traits, add new ones here
	if (capability == "PowerController"){return "action.devices.traits.OnOff"}
	else if(capability == "BrightnessController"){return "action.devices.traits.Brightness"}
	else if(capability == "ColorController" || capability == "ColorTemperatureController"){return "action.devices.traits.ColorSetting"}
	else if(capability == "ChannelController"){return "action.devices.traits.Channel"}
	else if(capability == "LockController"){return "action.devices.traits.LockUnlock"}
	else if(capability == "InputController"){return "action.devices.traits.InputSelector"}
	else if(capability == "PlaybackController"){return "action.devices.traits.MediaState"}
	else if(capability == "SceneController"){return "action.devices.traits.Scene"}
	else if(capability == "Speaker"){return "action.devices.traits.Volume"}
	else if(capability == "ThermostatController"){return "action.devices.traits.TemperatureSetting"}
	// Complex mappings - device-type specific capability mappings, generally RangeController/ ModeController centric
	else if(capability == "RangeController" && (type.indexOf('action.devices.types.AWNING') > -1 || type.indexOf('action.devices.types.BLINDS') > -1)){
		return "action.devices.traits.OpenClose";
	}
	else if(capability == "RangeController" && (type.indexOf('action.devices.types.FAN') > -1 || type.indexOf('action.devices.types.THERMOSTAT') > -1)){
		return "action.devices.traits.FanSpeed";
	}
	else {return "Not Supported"}
}
// Convert Alexa Device Types to Google Home-compatible
const gHomeReplaceType = async(type) => {
	// Limit supported device types, add new ones here
	if (type == "ACTIVITY_TRIGGER") {return "action.devices.types.SCENE"}
	else if (type == "EXTERIOR_BLIND") {return "action.devices.types.AWNING"}
	else if (type == "FAN") {return "action.devices.types.FAN"}
	else if (type == "INTERIOR_BLIND") {return "action.devices.types.BLINDS"}
	else if (type == "LIGHT") {return "action.devices.types.LIGHT"}
	else if (type == "SPEAKER") {return "action.devices.types.SPEAKER"}
	else if (type == "SMARTLOCK") {return "action.devices.types.LOCK"}
	else if (type == "SMARTPLUG") {return "action.devices.types.OUTLET"}
	else if (type == "SWITCH") {return "action.devices.types.SWITCH"}
	else if (type.indexOf('THERMOSTAT') > -1) {return "action.devices.types.THERMOSTAT"}
	else if (type == "TV") {return "action.devices.types.TV"}
	else {return "NA"}
}
// Nested attribute/ element tester
function getSafe(fn) {
	try {
		return fn();
    } catch (e) {
        return undefined;
    }
}

module.exports = {
	queryDeviceStateAsync,
	gHomeSyncAsync,
	sendStateAsync,
	requestToken2Async,
	gHomeReplaceCapability,
	gHomeReplaceType,
	validateCommandAsync
}