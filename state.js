///////////////////////////////////////////////////////////////////////////
// Depends
///////////////////////////////////////////////////////////////////////////
var Account = require('./models/account');
var Devices = require('./models/devices');
var ua = require('universal-analytics');
var mqtt = require('mqtt');
const uuidv4 = require('uuid/v4');
var logger = require('./config/logger');
///////////////////////////////////////////////////////////////////////////
// Functions
///////////////////////////////////////////////////////////////////////////
const gHomeFunc = require('./functions/func-ghome');
const alexaFunc = require('./functions/func-alexa');
const gHomeSendState =  gHomeFunc.sendState;
const gHomeQueryDeviceState = gHomeFunc.queryDeviceState;
const isGhomeUser = gHomeFunc.isGhomeUser;
const alexaSendState =  alexaFunc.sendState;
const alexaQueryDeviceState = alexaFunc.queryDeviceState;
const isAlexaUser = alexaFunc.isAlexaUser;
const requestToken2 = gHomeFunc.requestToken2;
///////////////////////////////////////////////////////////////////////////
// Variables
///////////////////////////////////////////////////////////////////////////
var debug = (process.env.ALEXA_DEBUG || false);
// MQTT ENV variables========================
var mqtt_user = (process.env.MQTT_USER);
var mqtt_password = (process.env.MQTT_PASSWORD);
var mqtt_port = (process.env.MQTT_PORT || "1883");
var mqtt_url = (process.env.MQTT_URL || "mqtt://mosquitto:" + mqtt_port);
// Google Auth JSON Web Token ================
var gToken = undefined; // Store Report State OAuth Token
const ghomeJWT = process.env.GHOMEJWT;
var gHomeReportState = false;
var keys;
if (!ghomeJWT) {
	logger.log('warn', "[GHome API] JSON Web Token not supplied via ghomeJWT environment variable. Google Home Report State disabled.")
}
else {
	gHomeReportState = true;
	keys = JSON.parse(ghomeJWT);
}
// Alexa State Reporting
var alexaReportState = false;
if (!process.env.ALEXA_CLIENTID && !process.env.ALEXA_CLIENTSECRET) {
	logger.log('warn', "[AlexaAuth API] ALEXA_CLIENTID and ALEXA_CLIENTSECRET environment variables undefined, state reporting disabled!");
}
else {
	alexaReportState = true;
}
// Google Analytics ==========================
var enableAnalytics = false;
if (process.env.GOOGLE_ANALYTICS_TID != undefined) {
    enableAnalytics = true;
    var visitor = ua(process.env.GOOGLE_ANALYTICS_TID);
}
///////////////////////////////////////////////////////////////////////////
// MQTT Client Configuration
///////////////////////////////////////////////////////////////////////////
var mqttClient;
var mqttOptions = {
	connectTimeout: 30 * 1000,
	reconnectPeriod: 1000,
	keepAlive: 10,
	clean: true,
	resubscribe: true,
	clientId: 'stateAPI_' + Math.random().toString(16).substr(2, 8)
};
if (mqtt_user) {
	mqttOptions.username = mqtt_user;
	mqttOptions.password = mqtt_password;
}
logger.log('info', "[State API] Connecting to MQTT server: " + mqtt_url);
mqttClient = mqtt.connect(mqtt_url, mqttOptions);
mqttClient.on('error',function(err){
	logger.log('error', "[State API] MQTT connect error");
});
mqttClient.on('reconnect', function(){
	logger.log('warn', "[State API] MQTT reconnect event");
});
mqttClient.on('connect', function(){
	logger.log('info', "[State API] MQTT connected, subscribing to 'state/#'")
	mqttClient.subscribe('state/#');
});

///////////////////////////////////////////////////////////////////////////
// Homegraph API Token Request/ Refresh
///////////////////////////////////////////////////////////////////////////
if (gHomeReportState == true) {
	requestToken2(keys, function(returnValue) {
		gToken = returnValue;
		logger.log('info', "[State API] Obtained Google HomeGraph OAuth token");
		logger.log('debug', "[State API] HomeGraph OAuth token:" + JSON.stringify(gToken));
	});
	// Refresh Google oAuth Token used for State Reporting
	var refreshToken = setInterval(function(){
		requestToken2(keys, function(returnValue) {
			gToken = returnValue;
			logger.log('info', "[State API] Refreshed Google HomeGraph OAuth token");
			logger.log('debug', "[State API] HomeGraph OAuth token:" + JSON.stringify(gToken));
		});
	},3540000);
}
///////////////////////////////////////////////////////////////////////////
// MQTT Message Handlers
///////////////////////////////////////////////////////////////////////////
var onGoingCommands = {};
// Event handler for received MQTT messages - note subscribe near top of script.
mqttClient.on('message',function(topic,message){
	var arrTopic = topic.split("/"); 
	var username = arrTopic[1];
	var endpointId = arrTopic[2];
    if (topic.startsWith('state/')){
		logger.log('info', "[State API] Acknowledged MQTT state message topic: " + topic);
		//if (debug == "true") {console.time('mqtt-state')};
		// Split topic/ get username and endpointId
		var messageJSON = JSON.parse(message);
		var payload = messageJSON.payload;
		// Call setstate to update attribute in mongodb
		setstate(username,endpointId,payload) //arrTopic[1] is username, arrTopic[2] is endpointId
		// Add message to onGoingCommands
		var stateWaiting = onGoingCommands[payload.messageId];
		if (stateWaiting) {
			if (payload.success) {
				logger.log('info', "[State API] Succesful MQTT state update for user: " + username + " device:" + endpointId);
                stateWaiting.res.status(200).send();
                // If successful remove messageId from onGoingCommands
                delete onGoingCommands[payload.messageId];
                var params = {
                    ec: "Set State",
                    ea: "State API successfully processed MQTT state for username: " + username + " device: " + endpointId,
                    uid: username,
                }
                if (enableAnalytics) {visitor.event(params).send()};
                //if (debug == "true") {console.timeEnd('mqtt-state')};
            } 
            else {
				logger.log('warn', "[State API] Failed MQTT state update for user: " + username + " device:" + endpointId);
                stateWaiting.res.status(503).send();
                var params = {
                    ec: "Set State",
                    ea: "State API failed to process MQTT state for username: " + username + " device: " + endpointId,
                    uid: username,
                }
                if (enableAnalytics) {visitor.event(params).send()};
                //if (debug == "true") {console.timeEnd('mqtt-state')};
			}
		}
	}
	else {
		logger.log('debug', "[MQTT] Unhandled MQTT via on message event handler: " + topic + message);
	}
});
///////////////////////////////////////////////////////////////////////////
// Timer
///////////////////////////////////////////////////////////////////////////
var timeout = setInterval(function(){
	var now = Date.now();
	var keys = Object.keys(onGoingCommands);
	for (key in keys){
		var waiting = onGoingCommands[keys[key]];
		logger.log('debug', "[MQTT] Queued MQTT message: " + keys[key]);
		if (waiting) {
			var diff = now - waiting.timestamp;
			if (diff > 6000) {
				logger.log('warn', "[MQTT] MQTT command timed out/ unacknowledged: " + keys[key]);
				waiting.res.status(504).send('{"error": "timeout"}');
				delete onGoingCommands[keys[key]];
				//measurement.send({
				//	t:'event', 
				//	ec:'command', 
				//	ea: 'timeout',
				//	uid: waiting.user
				//});
			}
		}
	}
},500);
///////////////////////////////////////////////////////////////////////////
// Functions
///////////////////////////////////////////////////////////////////////////
// Set State Function, sets device "state" element in MongoDB based upon Node-RED MQTT 'state' message
function setstate(username, endpointId, payload) {
	// Check payload has state property
	logger.log('debug', "[State API] SetState payload:" + JSON.stringify(payload));
	if (payload.hasOwnProperty('state')) {
		// Find existing device, we need to retain state elements, state is fluid/ will contain new elements so flattened input no good
		Devices.findOne({username:username, endpointId:endpointId},function(error,dev){
			if (error) {
				logger.log('warn', "[State API] Unable to find enpointId: " + endpointId + " for username: " + username);
				alert = 'State update sent for non-existent device (likely deleted), please review your flows!';
				notifyUser('error', username, endpointId, alert);
			}
			if (dev) {
				var dt = new Date().toISOString();
				var deviceJSON = JSON.parse(JSON.stringify(dev));
				var alert;
				dev.state = (dev.state || {});
				dev.state.time = dt;
				if (payload.state.hasOwnProperty('brightness')) { // Brightness, with validation
					if (typeof payload.state.brightness == 'number' && payload.state.brightness >= 0 && payload.state.brightness <= 100) {dev.state.brightness = payload.state.brightness}
					else {
						alert = '[' + dev.friendlyName + '] ' + 'Invalid brightness state, expecting payload.state.brightness (number, 0-100)';
						notifyUser('warn', username, endpointId, alert);
					}
				};
				if (payload.state.hasOwnProperty('channel')) { // Channel, with basic validation - can be either string or number
					if (typeof payload.state.channel == 'string' || payload.state.channel == 'number'){dev.state.channel = payload.state.channel}
					else {
						alert = '[' + dev.friendlyName + '] ' + 'Invalid channel state, expecting payload.state.channel (either string or number)';
						notifyUser('warn', username, endpointId, alert);
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
					else {
						alert = '[' + dev.friendlyName + '] ' + 'Invalid color state, expecting payload.state.colorHue (number, 0-360), payload.state.colorSaturation (number, 0-1) and payload.state.colorBrightness (number, 0-1)';
						notifyUser('warn', username, endpointId, alert);
					}
				};
				if (payload.state.hasOwnProperty('colorTemperature')) { // ColorTemperature, with validation
					if (typeof payload.state.colorTemperature == 'number' && (payload.state.colorTemperature >= 0 && payload.state.colorTemperature) <= 10000) {
						dev.state.colorTemperature = payload.state.colorTemperature;
						delete dev.state.colorBrightness;
						delete dev.state.colorHue;
						delete dev.state.colorSaturation;		
					}
					else {
						alert = '[' + dev.friendlyName + '] ' + 'Invalid colorTemperature state, expecting payload.state.colorTemperature (number, 0-10000)';
						notifyUser('warn', username, endpointId, alert);
					}
				};
				if (payload.state.hasOwnProperty('contact')) { // Contact, with validation
					if (typeof payload.state.contact == 'string' && (payload.state.contact == 'DETECTED' || payload.state.contact == 'NOT_DETECTED')) {dev.state.contact = payload.state.contact}
					else {
						alert = '[' + dev.friendlyName + '] ' + 'Invalid contact state, expecting payload.state.contact (string, DETECTED or NOT_DETECTED)';
						notifyUser('warn', username, endpointId, alert);
					}
				};
				if (payload.state.hasOwnProperty('input')) { // Input, with basic validation
					if (typeof payload.state.input == 'string'){dev.state.input = payload.state.input}
					else {
						alert = '[' + dev.friendlyName + '] ' + 'Invalid input state, expecting payload.state.input (string)';
						notifyUser('warn', username, endpointId, alert);
					}
				};
				if (payload.state.hasOwnProperty('lock')) { // Lock, with validation
					if (typeof payload.state.lock == 'string' && (payload.state.lock == 'LOCKED' || payload.state.lock == 'UNLOCKED')) {dev.state.lock = payload.state.lock}
					else {
						alert = '[' + dev.friendlyName + '] ' + 'Invalid lock state, expecting payload.state.lock (string, LOCKED or UNLOCKED)';
						notifyUser('warn', username, endpointId, alert);
					}
				};
				if (payload.state.hasOwnProperty('motion')) { // Motion, with validation
					if (typeof payload.state.motion == 'string' && (payload.state.motion == 'DETECTED' || payload.state.motion == 'NOT_DETECTED')) {dev.state.motion = payload.state.motion}
					else {
						alert = '[' + dev.friendlyName + '] ' + 'Invalid motion state, expecting payload.state.motion (string, DETECTED or NOT_DETECTED)';
						notifyUser('warn', username, endpointId, alert);
					}
				};
				if (payload.state.hasOwnProperty('mute')) { // Mute, with validation
					if (typeof payload.state.mute == 'boolean' && (payload.state.mute == true || payload.state.mute == false)) {dev.state.mute = payload.state.mute}
					else {
						alert = '[' + dev.friendlyName + '] ' + 'Invalid mute state, expecting payload.state.mute (boolean)';
						notifyUser('warn', username, endpointId, alert);
					}
				};
				if (payload.state.hasOwnProperty('percentage')) { // Percentage, with validation
					if (typeof payload.state.percentage == 'number' && payload.state.percentage >= 0 && payload.state.percentage <= 100) {dev.state.percentage = payload.state.percentage}
					else {
						alert = '[' + dev.friendlyName + '] ' + 'Invalid percentage state, expecting payload.state.percentage (number, 0-100)';
						notifyUser('warn', username, endpointId, alert);
					}
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
					else {
						alert = '[' + dev.friendlyName + '] ' + 'Invalid percentageDelta state, expecting payload.state.percentageDelta (number, -100-100)';
						notifyUser('warn', username, endpointId, alert);
					}
				};
				if (payload.state.hasOwnProperty('playback')) { // Playback, with basic validation
					if (typeof payload.state.playback == 'string'){dev.state.playback = payload.state.playback}
					else {
						alert = '[' + dev.friendlyName + '] ' + 'Invalid playback state, expecting payload.state.playback (string)';
						notifyUser('warn', username, endpointId, alert);
					}
				};
				if (payload.state.hasOwnProperty('power')) { // Power, with validation
					if (typeof payload.state.power == 'string' && (payload.state.power == 'ON' || payload.state.power == 'OFF')) {dev.state.power = payload.state.power}
					else {
						alert = '[' + dev.friendlyName + '] ' + 'Invalid power state, expecting payload.state.power (string, ON or OFF)';
						notifyUser('warn', username, endpointId, alert);
					}
				};
				if (payload.state.hasOwnProperty('rangeValue')) { // Range Value, with basic validation
					if (typeof payload.state.rangeValue == 'number'){
						dev.state.rangeValue = payload.state.rangeValue;
					}
					else {
						alert = '[' + dev.friendlyName + '] ' + 'Invalid rangeValue state, expecting payload.state.rangeValue (number)';
						notifyUser('warn', username, endpointId, alert);
					}
				};
				if (payload.state.hasOwnProperty('rangeValueDelta')) { // Range Value Delta, with basic validation
					if (typeof payload.state.rangeValueDelta == 'number'){
						if (dev.state.hasOwnProperty('rangeValue')) {
							var newRangeValue = dev.state.rangeValue + payload.state.rangeValueDelta;
							dev.state.rangeValue = newRangeValue;
						}
					}
					else {
						alert = '[' + dev.friendlyName + '] ' + 'Invalid rangeValueDelta state, expecting payload.state.rangeValueDelta (number)';
						notifyUser('warn', username, endpointId, alert);
					}
				};
				// Handle targetSetpointDelta, thermostatSetPoint and thermostatMode state updates
				if (payload.state.hasOwnProperty('targetSetpointDelta') || payload.state.hasOwnProperty('thermostatSetPoint') || payload.state.hasOwnProperty('thermostatMode')) {
					var newTemp = undefined;
					var newMode = undefined;
					if (dev.state.hasOwnProperty('thermostatSetPoint') && payload.state.hasOwnProperty('targetSetpointDelta')) {
						if (typeof payload.state.targetSetpointDelta == 'number'){ // Thermostat Set Point Delta, with basic validation
							newTemp = dev.state.thermostatSetPoint + payload.state.targetSetpointDelta;
						}
						else {
							alert = '[' + dev.friendlyName + '] ' + 'Invalid targetSetpointDelta state, expecting payload.state.targetSetpointDelta (number)';
							notifyUser('warn', username, endpointId, alert);
						}
					}
					else if (dev.state.hasOwnProperty('thermostatSetPoint') && payload.state.hasOwnProperty('thermostatSetPoint')) {
						if (typeof payload.state.thermostatSetPoint == 'number'){ // Thermostat Set Point, with basic validation
							newTemp = payload.state.thermostatSetPoint;
						}
						else {
							alert = '[' + dev.friendlyName + '] ' + 'Invalid thermostatSetPoint state, expecting payload.state.thermostatSetPoint (number)';
							notifyUser('warn', username, endpointId, alert);
						}
					}
					// Use included thermostatMode if exists
					if (payload.state.hasOwnProperty('thermostatMode')) { // Thermostat Mode, with basic validation
						if (typeof payload.state.thermostatMode == 'string'){
							newMode = payload.state.thermostatMode;
						}
						else {
							alert = '[' + dev.friendlyName + '] ' + 'Invalid thermostatMode state, expecting payload.state.thermostatMode (string)';
							notifyUser('warn', username, endpointId, alert);
						}
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
					else {
						alert = '[' + dev.friendlyName + '] ' + 'Invalid temperature state, expecting payload.state.temperature (number)';
						notifyUser('warn', username, endpointId, alert);
					}
				};
				if (payload.state.hasOwnProperty('volume')) { // Volume, with basic validation
					if (typeof payload.state.volume == 'number'){
						dev.state.volume = payload.state.volume;
					}
					else {
						alert = '[' + dev.friendlyName + '] ' + 'Invalid volume state, expecting payload.state.volume (number)';
						notifyUser('warn', username, endpointId, alert);
					}
				};
				if (payload.state.hasOwnProperty('volumeDelta')) { // Volume Delta, with basic validation
					if (dev.state.hasOwnProperty('volume')) { 
						if (typeof payload.state.volumeDelta == 'number'){
							var newVolume = dev.state.volume + payload.state.volumeDelta;
							dev.state.volume = newVolume;
						}
						else {
							alert = '[' + dev.friendlyName + '] ' + 'Invalid volumeDelta state, expecting payload.state.volumeDelta (number)';
							notifyUser('warn', username, endpointId, alert);
						}
					}
				};

				logger.log('debug', "[State API] Endpoint state update: " + JSON.stringify(dev.state));
				// Update state element with modified properties
				Devices.updateOne({username:username, endpointId:endpointId}, { $set: { state: dev.state }}, function(err, data) {
					if (err) {
						logger.log('debug', "[State API] Error updating state for endpointId: " + endpointId);
					}
					else {
						logger.log('debug', "[State API] Updated state for endpointId: " + endpointId);
						///////////////////////////////////////////////////////////////////////////
						// ASync State Updates
						///////////////////////////////////////////////////////////////////////////

						// Limit to specific device types
						var enableDevTypeStateReport = false;
						var hasdisplayCategories = getSafe(() => dev.displayCategories);
						if (hasdisplayCategories != undefined) {
							if (dev.displayCategories.indexOf("CONTACT_SENSOR") > -1) {enableDevTypeStateReport = true};
							if (dev.displayCategories.indexOf("MOTION_SENSOR") > -1) {enableDevTypeStateReport = true};
							if (dev.displayCategories.indexOf("THERMOSTAT") > -1) {enableDevTypeStateReport = true};
							if (dev.displayCategories.indexOf("LIGHT") > -1) {enableDevTypeStateReport = true}; // For testing only
							if (dev.displayCategories.indexOf("SMARTLOCK") > -1) {enableDevTypeStateReport = true}; // For testing only
						}
 						if (enableDevTypeStateReport == true && (gHomeReportState == true || alexaReportState == true)) {
							var pUser = Account.findOne({username: username});
							var pDevice = Devices.findOne({username: username, endpointId: endpointId});
							Promise.all([pUser, pDevice]).then(([user, device]) => {
								///////////////////////////////////////////////////////////////////////////
								// Google Home
								///////////////////////////////////////////////////////////////////////////
								isGhomeUser(user, function(returnValue) { // Check user is has linked account w/ Google
									if (returnValue == true && gHomeReportState == true) {
										try {
											//logger.log('debug', "[State API] GHome Report State using device:" + JSON.stringify(device));
											gHomeQueryDeviceState(device, function(response) {
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
														//logger.log('debug', "[State API] Generated GHome state report: " + JSON.stringify(stateReport));
														if (gToken != undefined) {
															//logger.log('verbose', '[State API] Calling Send State with gToken:' + JSON.stringify(gToken));
															gHomeSendState(gToken, stateReport, user.username);
														}
														else {
															logger.log('verbose', '[State API] Unable to call Send State, no gToken');
														}
													}
												}
											});											
										}
										catch (e) {logger.log('debug', "[State API] gHomeSendState error: " + e)};
									}
									else {
										//if (returnValue == false){logger.log('debug', "[State API] User: " + username + ", is not a Google Home user")};
										if (gHomeReportState == false){logger.log('debug', "[State API] GHome state reporting DISABLED")};
									}
								});
								///////////////////////////////////////////////////////////////////////////
								// Alexa
								///////////////////////////////////////////////////////////////////////////
								isAlexaUser(user, function(returnValue) {
									if (returnValue == true && alexaReportState == true) {
										try {
											//logger.log('debug', "[State API] Alexa Change report using device:" + JSON.stringify(device));
											alexaQueryDeviceState(device, function(state) {
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
											});
										}
										catch (e) {logger.log('debug', "[State API] alexaSendState error: " + e)}
									}
									else {
										//if (returnValue == false){logger.log('debug', "[State API] User: " + username + ", is not an Alexa user")};
										if (alexaReportState == false){logger.log('debug', "[State API] Alexa Report State DISABLED")};
									}
								});
							});
						} 
					}
				});
			}
		});
	}
	else {
		logger.log('warn', "[State API] setstate called, but MQTT payload has no 'state' property!");
	}
}

// Post MQTT message that users' Node-RED instance will display in GUI as warning
function notifyUser(severity, username, endpointId, message){
	var topic = "message/" + username + "/" + endpointId; // Prepare MQTT topic for client-side notifiations
	var alert = {};
	alert.severity = severity;
	alert.message = message
	try{
		mqttClient.publish(topic,JSON.stringify(alert));
		logger.log('warn', "[State API] Published MQTT alert for user: " + username + " endpointId: " + endpointId + " message: " + message);
	} catch (err) {
		logger.log('warn', "[State API] Failed to publish MQTT alert, error: " + err);
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
};


