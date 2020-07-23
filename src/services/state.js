///////////////////////////////////////////////////////////////////////////
// Depends
///////////////////////////////////////////////////////////////////////////
var Account = require('../models/account');
var Devices = require('../models/devices');
//const uuidv4 = require('uuid/v4');
const { v4: uuidv4 } = require('uuid');
const logger = require('../loaders/logger');
const fs = require('fs');
const util = require("util");
///////////////////////////////////////////////////////////////////////////
// Functions
///////////////////////////////////////////////////////////////////////////
const gHomeFunc = require('./func-ghome');
const alexaFunc = require('./func-alexa');
const ghomeJWT_file = './ghomejwt.json';
const gHomeSendState =  gHomeFunc.sendStateAsync;
const gHomeQueryDeviceState = gHomeFunc.queryDeviceStateAsync;
const alexaSendState =  alexaFunc.sendStateAsync;
const alexaQueryDeviceState = alexaFunc.queryDeviceStateAsync;
const requestToken2Async = gHomeFunc.requestToken2Async;
///////////////////////////////////////////////////////////////////////////
// Variables
///////////////////////////////////////////////////////////////////////////
const readFile = util.promisify(fs.readFile);
// Google Auth JSON Web Token ================
var gToken = undefined; // Store Report State OAuth Token
var gHomeReportState = false;
var keys; // variable used to store JWT for Out-of-Band State Reporting to Google Home Graph API
// Alexa State Reporting
var alexaReportState = false;
if (!process.env.ALEXA_CLIENTID && !process.env.ALEXA_CLIENTSECRET) {
	logger.log('warn', "[AlexaAuth API] ALEXA_CLIENTID and ALEXA_CLIENTSECRET environment variables undefined, state reporting disabled!");
}
else {
	alexaReportState = true;
}
///////////////////////////////////////////////////////////////////////////
// Main
///////////////////////////////////////////////////////////////////////////
const setupHomeGraph = async() => {
	try {
		var data = await readFile(ghomeJWT_file, 'utf8');
		gHomeReportState = true;
		keys = JSON.parse(data);
		// Request Token
		gToken = await requestToken2Async(keys);
		logger.log('info', "[State API] Obtained GHome HomeGraph OAuth token");
		//logger.log('debug', "[State API] GHome HomeGraph OAuth token:" + gToken);
	}
	catch(e) {
		logger.log('error', "[State API] Report state setup failed, error: " + e.stack );
	}
}

setupHomeGraph();

// Create timer job to re-request access token before expiration
var refreshToken = setInterval(function(){
	setupHomeGraph();
},3540000);
///////////////////////////////////////////////////////////////////////////
// Functions
///////////////////////////////////////////////////////////////////////////
// State update handler
const updateDeviceState = async(username, endpointId, payload) => {
	try {
		logger.log('debug', "[State API] SetState payload:" + JSON.stringify(payload));
		// Find matching device
		var dev = await Devices.findOne({username:username, endpointId:endpointId});
		// If no matching device found, stop further action (likely user has deleted device)
		if (!dev) return false;
		// Build state update
		var dt = new Date().toISOString();
		var deviceJSON = JSON.parse(JSON.stringify(dev));
		var alerts = [];
		// Start with existing state, if any
		dev.state = (dev.state || {});
		dev.state.time = dt;
		// Based on payload contents build revised state, keeping elements which have not changed
		if (payload.state.hasOwnProperty('brightness')) { // Brightness, with validation
			if (typeof payload.state.brightness == 'number' && payload.state.brightness >= 0 && payload.state.brightness <= 100) {dev.state.brightness = payload.state.brightness}
			else {alerts.push('[' + dev.friendlyName + '] ' + 'Invalid brightness state, expecting payload.state.brightness (number, 0-100)')}
		};
		if (payload.state.hasOwnProperty('channel')) { // Channel, with basic validation - can be either string or number
			if (typeof payload.state.channel == 'string' || payload.state.channel == 'number'){dev.state.channel = payload.state.channel}
			else {alerts.push('[' + dev.friendlyName + '] ' + 'Invalid channel state, expecting payload.state.channel (either string or number)')
			}
		};
		if (payload.state.hasOwnProperty('colorBrightness') && payload.state.hasOwnProperty('colorHue') && payload.state.hasOwnProperty('colorSaturation')) { // Color, with validation
			if ((typeof payload.state.colorHue == 'number'
				&& typeof payload.state.colorSaturation == 'number'
				&& typeof payload.state.colorBrightness == 'number'
				&& payload.state.colorHue >= 0 && payload.state.colorHue <= 360)
				&& (payload.state.colorSaturation >= 0 && payload.state.colorSaturation <= 1)
				&& (payload.state.colorBrightness >= 0 && payload.state.colorBrightness <= 1)) {
					dev.state.colorBrightness = payload.state.colorBrightness;
					dev.state.colorHue = payload.state.colorHue;
					dev.state.colorSaturation = payload.state.colorSaturation;
					delete dev.state.colorTemperature;
			}
			else {alerts.push('[' + dev.friendlyName + '] ' + 'Invalid color state, expecting payload.state.colorHue (number, 0-360), payload.state.colorSaturation (number, 0-1) and payload.state.colorBrightness (number, 0-1)')}
		};
		if (payload.state.hasOwnProperty('colorTemperature')) { // ColorTemperature, with validation
			if (typeof payload.state.colorTemperature == 'number' && (payload.state.colorTemperature >= 0 && payload.state.colorTemperature) <= 10000) {
				dev.state.colorTemperature = payload.state.colorTemperature;
				delete dev.state.colorBrightness;
				delete dev.state.colorHue;
				delete dev.state.colorSaturation;
			}
			else {alerts.push('[' + dev.friendlyName + '] ' + 'Invalid colorTemperature state, expecting payload.state.colorTemperature (number, 0-10000)')}
		};
		if (payload.state.hasOwnProperty('contact')) { // Contact, with validation
			if (typeof payload.state.contact == 'string' && (payload.state.contact == 'DETECTED' || payload.state.contact == 'NOT_DETECTED')) {dev.state.contact = payload.state.contact}
			else {alerts.push('[' + dev.friendlyName + '] ' + 'Invalid contact state, expecting payload.state.contact (string, DETECTED or NOT_DETECTED)')}
		};
		if (payload.state.hasOwnProperty('input')) { // Input, with basic validation
			if (typeof payload.state.input == 'string'){dev.state.input = payload.state.input}
			else {alerts.push('[' + dev.friendlyName + '] ' + 'Invalid input state, expecting payload.state.input (string)')}
		};
		if (payload.state.hasOwnProperty('lock')) { // Lock, with validation
			if (typeof payload.state.lock == 'string' && (payload.state.lock == 'LOCKED' || payload.state.lock == 'UNLOCKED')) {dev.state.lock = payload.state.lock}
			else {alerts.push('[' + dev.friendlyName + '] ' + 'Invalid lock state, expecting payload.state.lock (string, LOCKED or UNLOCKED)')}
		};
		if (payload.state.hasOwnProperty('mode')) { // Mode, with basic validation
			if (typeof payload.state.mode == 'string'){dev.state.mode = payload.state.mode}
			else {alerts.push('[' + dev.friendlyName + '] ' + 'Invalid mode state, expecting payload.state.mode (string)')}
		};
		if (payload.state.hasOwnProperty('motion')) { // Motion, with validation
			if (typeof payload.state.motion == 'string' && (payload.state.motion == 'DETECTED' || payload.state.motion == 'NOT_DETECTED')) {dev.state.motion = payload.state.motion}
			else {alerts.push('[' + dev.friendlyName + '] ' + 'Invalid motion state, expecting payload.state.motion (string, DETECTED or NOT_DETECTED)')}
		};
		if (payload.state.hasOwnProperty('mute')) { // Mute, with validation
			if (typeof payload.state.mute == 'boolean' && (payload.state.mute == true || payload.state.mute == false)) {dev.state.mute = payload.state.mute}
			else {alerts.push('[' + dev.friendlyName + '] ' + 'Invalid mute state, expecting payload.state.mute (boolean)')}
		};
		if (payload.state.hasOwnProperty('percentage')) { // Percentage, with validation
			if (typeof payload.state.percentage == 'number' && payload.state.percentage >= 0 && payload.state.percentage <= 100) {dev.state.percentage = payload.state.percentage}
			else {alerts.push('[' + dev.friendlyName + '] ' + 'Invalid percentage state, expecting payload.state.percentage (number, 0-100)')}
		};
		if (payload.state.hasOwnProperty('percentageDelta')) { // Percentage Delta, with validation
			if (typeof payload.state.percentageDelta == 'number' && payload.state.percentageDelta >= -100 && payload.state.percentageDelta <= 100) {
				if (dev.state.hasOwnProperty('percentage')) {
					var newPercentage = dev.state.percentage + payload.state.percentageDelta;
					if (newPercentage > 100) {newPercentage = 100}
					else if (newPercentage < 0) {newPercentage = 0}
					dev.state.percentage = newPercentage;
				}
			}
			else {alerts.push('[' + dev.friendlyName + '] ' + 'Invalid percentageDelta state, expecting payload.state.percentageDelta (number, -100-100)')}
		};
		if (payload.state.hasOwnProperty('playback')) { // Playback, with basic validation
			if (typeof payload.state.playback == 'string'){dev.state.playback = payload.state.playback}
			else {alerts.push('[' + dev.friendlyName + '] ' + 'Invalid playback state, expecting payload.state.playback (string)')}
		};
		if (payload.state.hasOwnProperty('power')) { // Power, with validation
			if (typeof payload.state.power == 'string' && (payload.state.power == 'ON' || payload.state.power == 'OFF')) {dev.state.power = payload.state.power}
			else {alerts.push('[' + dev.friendlyName + '] ' + 'Invalid power state, expecting payload.state.power (string, ON or OFF)')}
		};
		if (payload.state.hasOwnProperty('rangeValue')) { // Range Value, with basic validation
			if (typeof payload.state.rangeValue == 'number'){
				dev.state.rangeValue = payload.state.rangeValue;
			}
			else {alerts.push('[' + dev.friendlyName + '] ' + 'Invalid rangeValue state, expecting payload.state.rangeValue (number)')}
		};
		if (payload.state.hasOwnProperty('rangeValueDelta')) { // Range Value Delta, with basic validation
			if (typeof payload.state.rangeValueDelta == 'number'){
				if (dev.state.hasOwnProperty('rangeValue')) {
					var newRangeValue = dev.state.rangeValue + payload.state.rangeValueDelta;
					dev.state.rangeValue = newRangeValue;
				}
			}
			else {alerts.push('[' + dev.friendlyName + '] ' + 'Invalid rangeValueDelta state, expecting payload.state.rangeValueDelta (number)')}
		};
		// Handle targetSetpointDelta, thermostatSetPoint and thermostatMode state updates
		if (payload.state.hasOwnProperty('targetSetpointDelta') || payload.state.hasOwnProperty('thermostatSetPoint') || payload.state.hasOwnProperty('thermostatMode')) {
			var newTemp = undefined;
			var newMode = undefined;
			if (dev.state.hasOwnProperty('thermostatSetPoint') && payload.state.hasOwnProperty('targetSetpointDelta')) {
				if (typeof payload.state.targetSetpointDelta == 'number'){ // Thermostat Set Point Delta, with basic validation
					newTemp = dev.state.thermostatSetPoint + payload.state.targetSetpointDelta;
				}
				else {alerts.push('[' + dev.friendlyName + '] ' + 'Invalid targetSetpointDelta state, expecting payload.state.targetSetpointDelta (number)')}
			}
			else if (dev.state.hasOwnProperty('thermostatSetPoint') && payload.state.hasOwnProperty('thermostatSetPoint')) {
				if (typeof payload.state.thermostatSetPoint == 'number'){ // Thermostat Set Point, with basic validation
					newTemp = payload.state.thermostatSetPoint;
				}
				else {alerts.push('[' + dev.friendlyName + '] ' + 'Invalid thermostatSetPoint state, expecting payload.state.thermostatSetPoint (number)')}
			}
			// Use included thermostatMode if exists
			if (payload.state.hasOwnProperty('thermostatMode')) { // Thermostat Mode, with basic validation
				if (typeof payload.state.thermostatMode == 'string'){
					newMode = payload.state.thermostatMode;
				}
				else {alerts.push('[' + dev.friendlyName + '] ' + 'Invalid thermostatMode state, expecting payload.state.thermostatMode (string)')}
			}
			// Use existing thermostatMode if possible
			else if (!payload.state.hasOwnProperty('thermostatMode') && deviceJSON.attributes.hasOwnProperty('thermostatModes')){
				newMode = dev.state.thermostatMode;
			}
			// Use fall-back thermostatMode if necessary
			else if (!payload.state.hasOwnProperty('thermostatMode')) {
				newMode = "HEAT";
			}
			if (newTemp != undefined){dev.state.thermostatSetPoint = newTemp};
			if (newMode != undefined){dev.state.thermostatMode = newMode};
			// Check within supported range of device
			// if (deviceJSON.hasOwnProperty('attributes')) {
			// 	if (deviceJSON.attributes.hasOwnProperty('temperatureRange')) {
			// 		if (deviceJSON.attributes.temperatureRange.hasOwnProperty('temperatureMin') && deviceJSON.attributes.temperatureRange.hasOwnProperty('temperatureMax')) {
			// 			if (!(newTemp < deviceJSON.attributes.temperatureRange.temperatureMin) || !(newTemp > deviceJSON.attributes.temperatureRange.temperatureMax)) {
			// 				dev.state.thermostatSetPoint = newTemp;
			// 				dev.state.thermostatMode = newMode;
			// 			}
			// 		}
			// 	}
			// }
		};
		if (payload.state.hasOwnProperty('temperature')) { // Temperature, with basic validation
			if (typeof payload.state.temperature == 'number'){
				dev.state.temperature = payload.state.temperature;
			}
			else {alerts.push('[' + dev.friendlyName + '] ' + 'Invalid temperature state, expecting payload.state.temperature (number)')}
		};
		if (payload.state.hasOwnProperty('volume')) { // Volume, with basic validation
			if (typeof payload.state.volume == 'number'){
				dev.state.volume = payload.state.volume;
			}
			else {alerts.push('[' + dev.friendlyName + '] ' + 'Invalid volume state, expecting payload.state.volume (number)')}
		};
		if (payload.state.hasOwnProperty('volumeDelta')) { // Volume Delta, with basic validation
			if (dev.state.hasOwnProperty('volume')) {
				if (typeof payload.state.volumeDelta == 'number'){
					var newVolume = dev.state.volume + payload.state.volumeDelta;
					dev.state.volume = newVolume;
				}
				else {alerts.push('[' + dev.friendlyName + '] ' + 'Invalid volumeDelta state, expecting payload.state.volumeDelta (number)')}
			}
		};
		// Catch validation errors
		if (alerts.length > 0) {
			logger.log('warn', "[State] State update failed due to validation failure, device: " + endpointId + ", alerts: " + alerts);
			// Return Array of Validation Error Messages
			return alerts;
		}
		// No validation errors, update device state element
		else {
			// Update device state element
			await Devices.updateOne({username:username, endpointId:endpointId}, { $set: { state: dev.state }});
			// Get up-to-date device
			var device = await  Devices.findOne({username: username, endpointId: endpointId});
			// Get device associated user
			var user = await Account.findOne({username: username});
			// Send Google Home State Update, if user is Google Home-enabled
			if (user.activeServices && user.activeServices.indexOf('Google') > -1){sendGoogleHomeState(user, device)};
			// Send Alexa State Update, if user is Alexa-enabled
			if (user.activeServices && user.activeServices.indexOf('Amazon') > -1){sendAlexaState(user, device)};
			// Return Success
			return true;
		}
	}
	catch (e) {
		// Catch and log error stack
		logger.log('error', "[State] Unable to update state for device: " + endpointId + ", error: " + e.stack);
		// Return Failure
		return false;
	}
}

// Report State Function for Google Homegraph API
const sendGoogleHomeState = async(user, device) => {
	try {
		// Limit state reporting to specific device types
		var enableDevTypeStateReport = false;
		var sendGoogleStateUpdate = false; // NO state-supporting devices by default send updates to Google
		var hasdisplayCategories = getSafe(() => device.displayCategories);
		if (hasdisplayCategories != undefined) {
			// Per-device type send-state configuration, can enable/ disable Alexa and/ or Google Home
			if (device.displayCategories.indexOf("CONTACT_SENSOR") > -1) {
				enableDevTypeStateReport = true;
				//sendGoogleStateUpdate = true;
			}
			else if (device.displayCategories.indexOf("INTERIOR_BLIND") > -1) {
				enableDevTypeStateReport = true;
				sendGoogleStateUpdate = true;
			}
			else if (device.displayCategories.indexOf("EXTERIOR_BLIND") > -1) {
				enableDevTypeStateReport = true;
				sendGoogleStateUpdate = true;
			}
			else if (device.displayCategories.indexOf("FAN") > -1) {
				enableDevTypeStateReport = true;
				sendGoogleStateUpdate = true;
			}
			else if (device.displayCategories.indexOf("LIGHT") > -1) {
				enableDevTypeStateReport = true;
				sendGoogleStateUpdate = true;
			}
			else if (device.displayCategories.indexOf("MOTION_SENSOR") > -1) {
				enableDevTypeStateReport = true;
			}
			else if (device.displayCategories.indexOf("THERMOSTAT") > -1) {
				enableDevTypeStateReport = true;
				sendGoogleStateUpdate = true;
			}
			else if (device.displayCategories.indexOf("SMARTPLUG") > -1) {
				enableDevTypeStateReport = true;
				sendGoogleStateUpdate = true;
			}
			else if (device.displayCategories.indexOf("SMARTLOCK") > -1) {
				enableDevTypeStateReport = true;
				sendGoogleStateUpdate = true;
			}
			else {
				// Unless device type specifically defined above, state updates will NOT be sent
			}
		}

		// If user is Google Home user/ Report State is Enable, send state update to Home Graph API
		if (gHomeReportState == true && sendGoogleStateUpdate == true && enableDevTypeStateReport == true){
			var response = await gHomeQueryDeviceState(device);
			if (response != undefined) {
				var stateReport = {
					"agentUserId": user._id,
					"payload": {
						"devices" : {
							"states": {}
						}
					}
				}
				var countProps = Object.keys(response).length; // Drop anything that simply has online: true property
				if (countProps >= 2) {
					stateReport.payload.devices.states[device.endpointId] = response;
					logger.log('debug', "[State API] Generated GHome state report for user: " + user.username + ", report: " + JSON.stringify(stateReport));
					if (gToken != undefined) {
						//logger.log('verbose', '[State API] Calling Send State with gToken:' + JSON.stringify(gToken));
						gHomeSendState(gToken, stateReport, user.username);
					}
					else {
						logger.log('verbose', '[State API] Unable to call GHome Send State, no gToken');
					}
				}
			}
		}
		else {
			if (gHomeReportState == false){logger.log('debug', "[State API] GHome state reporting DISABLED")};
		}
	}
	catch(e) {
		logger.log('debug', "[State API] GHome gHomeSendState error: " + e.stack)
	}
}

const sendAlexaState = async(user, device) => {
	try {
		// Limit state reporting to specific device types
		var enableDevTypeStateReport = false;
		var sendAlexaStateUpdate = true; // ALL state-supporting devices by default send updates to Alexa
		var hasdisplayCategories = getSafe(() => device.displayCategories);
		if (hasdisplayCategories != undefined) {
			// Per-device type send-state configuration, can enable/ disable Alexa and/ or Google Home
			if (device.displayCategories.indexOf("CONTACT_SENSOR") > -1) {
				enableDevTypeStateReport = true;
				//sendGoogleStateUpdate = true;
			}
			else if (device.displayCategories.indexOf("INTERIOR_BLIND") > -1) {
				enableDevTypeStateReport = true;
				sendGoogleStateUpdate = true;
			}
			else if (device.displayCategories.indexOf("EXTERIOR_BLIND") > -1) {
				enableDevTypeStateReport = true;
				sendGoogleStateUpdate = true;
			}
			else if (device.displayCategories.indexOf("FAN") > -1) {
				enableDevTypeStateReport = true;
				sendGoogleStateUpdate = true;
			}
			else if (device.displayCategories.indexOf("LIGHT") > -1) {
				enableDevTypeStateReport = true;
				sendGoogleStateUpdate = true;
			}
			else if (device.displayCategories.indexOf("MOTION_SENSOR") > -1) {
				enableDevTypeStateReport = true;
			}
			else if (device.displayCategories.indexOf("THERMOSTAT") > -1) {
				enableDevTypeStateReport = true;
				sendGoogleStateUpdate = true;
			}
			else if (device.displayCategories.indexOf("SMARTPLUG") > -1) {
				enableDevTypeStateReport = true;
				sendGoogleStateUpdate = true;
			}
			else if (device.displayCategories.indexOf("SMARTLOCK") > -1) {
				enableDevTypeStateReport = true;
				sendGoogleStateUpdate = true;
			}
			else {
				// Unless device type specifically defined above, state updates will NOT be sent
			}
		}
		if (alexaReportState == true && sendAlexaStateUpdate == true && enableDevTypeStateReport == true) {
			var state = await alexaQueryDeviceState(device);
			if (state != undefined) {
				var messageId = uuidv4(); // Generate messageId
				var changeReport = {
					event: {
						header: {
							namespace: "Alexa",
							name: "ChangeReport",
							payloadVersion: "3",
							messageId: messageId
						},
						endpoint: {
						scope: {
							type: "BearerToken",
							token: "placeholder"
						},
						endpointId: device.endpointId
						},
						payload: {
							change: {
								cause: {
								type: "APP_INTERACTION"
								},
								properties: state
							}
						}
					}
				}
				alexaSendState(user, changeReport);
			}
		}
		else {
			if (alexaReportState == false){logger.log('debug', "[State API] Alexa Report State DISABLED")};
		}
	}
	catch(e) {
		logger.log('debug', "[State API] alexaSendState error: " + e);
		return false;
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
};

module.exports = {
	updateDeviceState
}


