///////////////////////////////////////////////////////////////////////////
// Depends
///////////////////////////////////////////////////////////////////////////
var express = require('express');
var router = express.Router();
var bodyParser = require('body-parser');
router.use(bodyParser.urlencoded({ extended: true }));
router.use(bodyParser.json());
//var Account = require('../models/account');
//var oauthModels = require('../models/oauth');
var Devices = require('../models/devices');
var passport = require('passport');
var logger = require('../loaders/logger');
var mqttClient = require('../loaders/mqtt').mqttClient;
var ongoingCommands = require('../loaders/mqtt').ongoingCommands;
//var client = require('../loaders/staging/redis-mqtt'); // Redis MQTT Command Holding Area
const defaultLimiter = require('../loaders/limiter').defaultLimiter;
const getStateLimiter = require('../loaders/limiter').getStateLimiter;
///////////////////////////////////////////////////////////////////////////
// Functions
///////////////////////////////////////////////////////////////////////////
//const servicesFunc = require('../services/func-services');
//const alexaFunc = require('../services/func-alexa');
//const queryDeviceState = alexaFunc.queryDeviceState;
//const saveGrant = alexaFunc.saveGrant;
const updateUserServices = require('../services/func-services').updateUserServices;
const queryDeviceStateAsync = require('../services/func-alexa').queryDeviceStateAsync;
const replaceCapability = require('../services/func-alexa').replaceCapabilityAsync;
const saveGrantAsync = require('../services/func-alexa').saveGrantAsync;
//const sendPageView = require('../services/ganalytics').sendPageView;
//const sendPageViewUid = require('../services/ganalytics').sendPageViewUid;
const sendEventUid = require('../services/ganalytics').sendEventUid;
///////////////////////////////////////////////////////////////////////////
// Variables
///////////////////////////////////////////////////////////////////////////
//var debug = (process.env.ALEXA_DEBUG || false);
///////////////////////////////////////////////////////////////////////////
// Discovery API, can be tested via credentials of an account/ browsing to http://<hostname>/api/v1/devices
///////////////////////////////////////////////////////////////////////////
router.get('/devices',
	passport.authenticate(['bearer', 'basic'], { session: false }),
	async (req, res) => {
		sendEventUid(req.path, "Discovery", "Running device discovery", req.ip, req.user.username, req.headers['user-agent']);
		var user = req.user.username;
		var devices = await Devices.find({username: user});
		var devs = [];
		for (let device of devices) {
			var dev = {};
			// Stringify endpointId
			dev.endpointId = "" + device.endpointId;
			dev.friendlyName = device.friendlyName;
			dev.description = device.description;
			dev.displayCategories = device.displayCategories;
			//dev.reportState = device.reportState;
			// Handle multiple capabilities, call replaceCapability to replace placeholder capabilities
			dev.capabilities = [];
			// Grab device attributes for use in building discovery response
			var devAttributes = (device.attributes || null);
			for (let capability of device.capabilities){
				// Get Alexa-ified capability
				let alexaCapability = await replaceCapability(capability, device.reportState, devAttributes, dev.displayCategories);
				// Push to device capabilities
				dev.capabilities.push(alexaCapability);
			}
			// Add specific RangeController interface
			if (device.capabilities.indexOf('RangeController') > -1){
				dev.capabilities.push(
				{  "type": "AlexaInterface",
					"interface": "Alexa",
					"version": "3"
				});
			}
			dev.cookie = device.cookie;
			dev.version = "0.0.3";
			dev.manufacturerName = "Node-RED"
			devs.push(dev);
		}
		res.send(devs);
	}
);

///////////////////////////////////////////////////////////////////////////
// Get State API res.status(200).json(properties);
///////////////////////////////////////////////////////////////////////////
router.get('/getstate/:dev_id', getStateLimiter,
	passport.authenticate(['bearer', 'basic'], { session: false }),
	async (req, res) => {
		try {
			var id = req.params.dev_id;
			sendEventUid(req.path, "Get State", "GetState API Request, endpointId: " + id, req.ip, req.user.username, req.headers['user-agent']);
			// As user has authenticated, assume activeService
			var serviceName = "Amazon";
			if (!req.user.activeServices || (req.user.activeServices && req.user.activeServices.indexOf(serviceName)) == -1) {updateUserServices(req.user.username, serviceName)};
			// Fine Device using endpointId supplied in req.params.dev_id
			var device = await Devices.findOne({username:req.user.username, endpointId:id});
			// Generate state response
			if (device) var state = await queryDeviceStateAsync(device);
			// Success, return state as JSON
			if (state && state != undefined) {
				//logger.log('debug', "[State API] Callback returned: " + JSON.stringify(state));
				res.status(200).json(state);
			}
			// Failure, return 500 error
			else {
				res.status(500).send();
			}
		}
		catch(e) {
			// General failure
			logger.log('error', "[Alexa State API] Error getting state for endpointId: " + req.params.dev_id + ", error: " + e.stack);
		}
	}
);

///////////////////////////////////////////////////////////////////////////
// Set State API (Not in Use)
///////////////////////////////////////////////////////////////////////////
// router.post('/setstate/:dev_id',
// 	passport.authenticate(['bearer', 'basic'], { session: false }),
// 	function(req,res,next){
// 		// do nothing, disused for now, may use along side command API
// 	}
// );

///////////////////////////////////////////////////////////////////////////
// Start Alexa Command API v2 (replaces much of the Lambda functionality)
///////////////////////////////////////////////////////////////////////////
router.post('/command2',
	passport.authenticate('bearer', { session: false }),
	async (req, res) => {
		try {
			sendEventUid(req.path, "Command", "Execute Command, endpointId: " + req.body.directive.endpoint.endpointId, req.ip, req.user.username, req.headers['user-agent']);
			var serviceName = "Amazon"; // As user has authenticated, assume activeService
			if (!req.user.activeServices || (req.user.activeServices && req.user.activeServices.indexOf(serviceName)) == -1) {updateUserServices(req.user.username, serviceName)};
			logger.log('debug', "[Alexa API] Received command for user: " + req.user.username + ", command: " + JSON.stringify(req.body));
			// Find matching device
			var device = await Devices.findOne({username:req.user.username, endpointId:req.body.directive.endpoint.endpointId});
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
				else if (namespace == "Alexa.ThermostatController"
					&& (name == "AdjustTargetTemperature" || name == "SetTargetTemperature" || name == "SetThermostatMode")) {
					// Workout new targetSetpoint
					if (name == "AdjustTargetTemperature") {
						var newTemp, scale, newMode;
						// Workout values for targetTemperature
						var hasthermostatSetPoint = getSafe(() => deviceJSON.state.thermostatSetPoint);
						var hasTemperatureScale  = getSafe(() => deviceJSON.attributes.temperatureScale);
						if (hasthermostatSetPoint != undefined){newTemp = deviceJSON.state.thermostatSetPoint + req.body.directive.payload.targetSetpointDelta.value}
						else {newTemp = req.body.directive.payload.targetSetpointDelta.value}
						if (hasTemperatureScale != undefined){scale = deviceJSON.attributes.temperatureScale}
						else {scale = req.body.directive.payload.targetSetpointDelta.scale}
					}
					else if (name == "SetTargetTemperature") { // Use command-supplied fields
						newTemp = req.body.directive.payload.targetSetpoint.value;
						sclae = req.body.directive.payload.targetSetpoint.scale;
					}
					// Workout new thermostatMode
					var hasThermostatModes = getSafe(() => deviceJSON.attributes.thermostatModes);
					if (hasThermostatModes != undefined){
						newMode = deviceJSON.state.thermostatMode;
					}
					else {
						newMode = "HEAT";
					}
					var targetSetPointValue = {
						"value": newTemp,
						"scale": scale
					};
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
							"value": newMode,
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
				//logger.log('debug', "[Alexa API] Command response: " + response);

				// Prepare MQTT topic/ message validation
				var topic = "command/" + req.user.username + "/" + req.body.directive.endpoint.endpointId;
				var validationStatus = true;

				// Cleanup MQTT message
				delete req.body.directive.header.correlationToken;
				delete req.body.directive.endpoint.scope.token;
				var message = JSON.stringify(req.body);
				logger.log('debug', "[Alexa Command] Received command API request for user: " + req.user.username + " command: " + message);

				//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

				// Check attributes.colorTemperatureRange, send 417 to Lambda (VALUE_OUT_OF_RANGE) response if values are out of range
				if (namespace == "Alexa.ColorTemperatureController" && name == "SetColorTemperature") {
					var compare = req.body.directive.payload.colorTemperatureInKelvin;
					// Handle Out of Range
					var hasColorTemperatureRange = getSafe(() => deviceJSON.attributes.colorTemperatureRange);
					if (hasColorTemperatureRange != undefined) {
						if (compare < deviceJSON.attributes.colorTemperatureRange.temperatureMinK || compare > deviceJSON.attributes.colorTemperatureRange.temperatureMaxK) {
							logger.log('warn', "[Alexa Command] User: " + req.user.username + ", requested color temperature: " + compare + ", on device: " + req.body.directive.endpoint.endpointId + ", which is out of range: " + JSON.stringify(deviceJSON.attributes.colorTemperatureRange));
							// Send 417 HTTP code back to Lamnda, Lambda will send correct error message to Alexa
							res.status(417).send();
							validationStatus = false;
						}
					}
					else {logger.log('debug', "[Alexa Command] Device: " + req.body.directive.endpoint.endpointId + " does not have attributes.colorTemperatureRange defined")}
				}

				// Check attributes.temperatureRange, send 416 to Lambda (TEMPERATURE_VALUE_OUT_OF_RANGE) response if values are out of range
				if (req.body.directive.header.namespace == "Alexa.ThermostatController" && req.body.directive.header.name == "SetTargetTemperature") {
					var compare = req.body.directive.payload.targetSetpoint.value;
					// Handle Temperature Out of Range
					var hasTemperatureRange = getSafe(() => deviceJSON.attributes.temperatureRange);
					if (hasTemperatureRange != undefined) {
						if (compare < deviceJSON.attributes.temperatureRange.temperatureMin || compare > deviceJSON.attributes.temperatureRange.temperatureMax) {
							logger.log('warn', "[Alexa Command] User: " + req.user.username + ", requested temperature: " + compare + ", on device: " + req.body.directive.endpoint.endpointId + ", which is out of range: " + JSON.stringify(deviceJSON.attributes.temperatureRange));
							// Send 416 HTTP code back to Lamnda, Lambda will send correct error message to Alexa
							res.status(416).send();
							validationStatus = false;
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

				if (validationStatus) {
					try{
						// Send Command to MQTT
						mqttClient.publish(topic,message);
						logger.log('info', "[Alexa Command] Published MQTT command for user: " + req.user.username + " topic: " + topic);
					} catch (err) {
						logger.log('warn', "[Alexa Command] Failed to publish MQTT command for user: " + req.user.username);
					}
					var command = {
						user: req.user.username,
						userId: req.user._id,
						res: res,
						response: response,
						source: "Alexa",
						timestamp: Date.now()
					};

					ongoingCommands[req.body.directive.header.messageId] = command;
					//client.hset(req.body.directive.header.messageId, 'command', command); // Command drops into redis database, used to generate failure messages if not ack
				}
		}
		catch(e) {
			logger.log('error', "[Alexa Command] Failed to execute command for user: " + req.user.username + ", error: " + e.stack);
			res.status(404).send();
		}
	}
);
///////////////////////////////////////////////////////////////////////////
// Temporary Auth Test
///////////////////////////////////////////////////////////////////////////
/* router.get('/authtest', getStateLimiter,
	passport.authenticate(['bearer', 'basic'], { session: false }),
	function(req,res,next){
		requestAccessToken(req.user, function(accesstoken) {
			if (accesstoken != undefined) {
				logger.log('info', "[TEST] Success, sending: " + JSON.stringify(accesstoken));
				res.status(200).json(accesstoken);
			}
			else {
				logger.log('error', "[TEST] Failed");
				res.status(200).send("failed");
			}
		});
}); */

///////////////////////////////////////////////////////////////////////////
// Alexa Authorization Handler (Under Development)
///////////////////////////////////////////////////////////////////////////
router.post('/authorization', defaultLimiter,
	passport.authenticate(['bearer', 'basic'], { session: false }),
	async (req, res) => {
		//const user = await User.findOne({email: req.body.email})
		if (req.body.directive.payload.grant.type == "OAuth2.AuthorizationCode") {
			logger.log('info', "[Alexa Authorization] Request body: " + JSON.stringify(req.body));
			var messageId = req.body.directive.header.messageId;
			var grantcode = req.body.directive.payload.grant.code;
			// Pre-build success and failure responses
			var success = {
					event: {
					header: {
						messageId: messageId,
						namespace: "Alexa.Authorization",
						name: "AcceptGrant.Response",
						payloadVersion: "3"
					},
					payload: {}
				}
			};
			var failure = {
				event: {
					header: {
						messageId: messageId,
						namespace: "Alexa.Authorization",
						name: "ErrorResponse",
						payloadVersion: "3"
					},
					payload: {
						type: "ACCEPT_GRANT_FAILED",
						message: "Failed to handle the AcceptGrant directive"
					}
				}
			};
			// Save GrantCode and attempt to generate AccessToken
			var grant = await saveGrantAsync(req.user, grantcode);
			if (grant != undefined) {
				res.status(200).json(success);
			}
			else {
				logger.log('error', "[Alexa Authorization] General failure, sending: " + JSON.stringify(failure));
				res.status(200).json(failure);
			}
		}
});

///////////////////////////////////////////////////////////////////////////
// Functions
///////////////////////////////////////////////////////////////////////////
// Nested attribute/ element tester
function getSafe(fn) {
	try {
		return fn();
    } catch (e) {
        return undefined;
    }
}

module.exports = router;


