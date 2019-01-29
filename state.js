///////////////////////////////////////////////////////////////////////////
// Depends
///////////////////////////////////////////////////////////////////////////
var Account = require('./models/account');
var Devices = require('./models/devices');
var ua = require('universal-analytics');
var mqtt = require('mqtt');
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
		if (debug == "true") {console.time('mqtt-state')};
		// Split topic/ get username and endpointId
		var messageJSON = JSON.parse(message);
		var payload = messageJSON.payload;
		// Call setstate to update attribute in mongodb
		setstate(username,endpointId,payload) //arrTopic[1] is username, arrTopic[2] is endpointId
		// Add message to onGoingCommands
		var stateWaiting = onGoingCommands[payload.messageId];
		if (stateWaiting) {
			if (payload.success) {
				logger.log('info', "[State API] Succesful MQTT state update for user:" + username + " device:" + endpointId);
                stateWaiting.res.status(200).send();
                // If successful remove messageId from onGoingCommands
                delete onGoingCommands[payload.messageId];
                var params = {
                    ec: "Set State",
                    ea: "State API successfully processed MQTT state for username: " + username + " device: " + endpointId,
                    uid: username,
                }
                if (enableAnalytics) {visitor.event(params).send()};
                if (debug == "true") {console.timeEnd('mqtt-state')};
            } 
            else {
				logger.log('warn', "[State API] Failed MQTT state update for user:" + username + " device:" + endpointId);
                stateWaiting.res.status(503).send();
                var params = {
                    ec: "Set State",
                    ea: "State API failed to process MQTT state for username: " + username + " device: " + endpointId,
                    uid: username,
                }
                if (enableAnalytics) {visitor.event(params).send()};
                if (debug == "true") {console.timeEnd('mqtt-state')};
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
			}
			if (dev) {
				var dt = new Date().toISOString();
				var deviceJSON = JSON.parse(JSON.stringify(dev));
				dev.state = (dev.state || {});
				dev.state.time = dt;
				if (payload.state.hasOwnProperty('brightness')) {dev.state.brightness = payload.state.brightness};
				if (payload.state.hasOwnProperty('channel')) {dev.state.input = payload.state.channel};
				if (payload.state.hasOwnProperty('colorBrightness')) {dev.state.colorBrightness = payload.state.colorBrightness};
				if (payload.state.hasOwnProperty('colorHue')) {dev.state.colorHue = payload.state.colorHue};
				if (payload.state.hasOwnProperty('colorSaturation')) {dev.state.colorSaturation = payload.state.colorSaturation};
				if (payload.state.hasOwnProperty('colorTemperature')) {dev.state.colorTemperature = payload.state.colorTemperature}
				if (payload.state.hasOwnProperty('input')) {dev.state.input = payload.state.input};
				if (payload.state.hasOwnProperty('lock')) {dev.state.lock = payload.state.lock};
				if (payload.state.hasOwnProperty('percentage')) {dev.state.percentage = payload.state.percentage};
				if (payload.state.hasOwnProperty('percentageDelta')) {
					if (dev.state.hasOwnProperty('percentage')) {
						var newPercentage = dev.state.percentage + payload.state.percentageDelta;
						if (newPercentage > 100) {newPercentage = 100}
						else if (newPercentage < 0) {newPercentage = 0}
						dev.state.percentage = newPercentage;
					}
				};
				if (payload.state.hasOwnProperty('playback')) {dev.state.playback = payload.state.playback};
				if (payload.state.hasOwnProperty('power')) {dev.state.power = payload.state.power}
				if (payload.state.hasOwnProperty('targetSetpointDelta')) {
					if (dev.state.hasOwnProperty('thermostatSetPoint')) {
						var newMode;
						var newTemp = dev.state.thermostatSetPoint + payload.state.targetSetpointDelta;
						// Get Supported Ranges and work-out new value for thermostatMode
						if (deviceJSON.attributes.hasOwnProperty('thermostatModes')){
							var countModes = deviceJSON.attributes.thermostatModes.length;
							var arrModes = deviceJSON.attributes.thermostatModes;
							// If single mode is supported leave as-is
							if (countModes == 1){
								newMode = dev.state.thermostatMode;
							}
							else {
								var auto = false;
								var heat = false;
								var cool = false;
								var on = false;
								var off = false;
								if (arrModes.indexOf('AUTO') > -1){auto = true};
								if (arrModes.indexOf('HEAT') > -1){heat = true};
								if (arrModes.indexOf('COOL') > -1){cool = true};
								if (arrModes.indexOf('ON') > -1){on = true};
								if (arrModes.indexOf('OFF') > -1){off = true};
								// Supported combos
									// ON and OFF
									// HEAT and COOL
									// HEAT, COOl, AUTO
									// HEAT, COOl, AUTO, ON, OFF
								if (countModes == 2 && (on && off)) { // On and Off Supported
									if (newTemp < dev.state.thermostatSetPoint ) {newMode = "OFF"}
									else {newMode = "ON"}
								}
								else if (countModes == 2 && (heat && cool)) { // Cool and Heat Supported
									if (newTemp < dev.state.thermostatSetPoint ) {newMode = "COOL"}
									else {newMode = "HEAT"}
								}
								else if (countModes == 3 && (heat && cool && auto)) { // Heat, Cool and Auto Supported
									if (newTemp < dev.state.thermostatSetPoint ) {newMode = "COOL"}
									else {newMode = "HEAT"}
								}
								else if (countModes == 5 && (on && off && on && off && auto)) { // All Modes Supported
									if (newTemp < dev.state.thermostatSetPoint ) {newMode = "COOL"}
									else {newMode = "HEAT"}
								}
								else { // Fallback position
									newMode = "HEAT";
								}
							}
						}
						// Check within supported range of device
						if (deviceJSON.hasOwnProperty('attributes')) {
							if (deviceJSON.attributes.hasOwnProperty('temperatureRange')) {
								if (deviceJSON.attributes.temperatureRange.hasOwnProperty('temperatureMin') && deviceJSON.attributes.temperatureRange.hasOwnProperty('temperatureMax')) {
									if (!(newTemp < deviceJSON.attributes.temperatureRange.temperatureMin) || !(newTemp > deviceJSON.attributes.temperatureRange.temperatureMax)) {
										dev.state.thermostatSetPoint = newTemp;
										dev.state.thermostatMode = newMode;
									}
								}

							}
						}
					}
				}
				if (payload.state.hasOwnProperty('temperature')) {dev.state.temperature = payload.state.temperature};
				if (payload.state.hasOwnProperty('thermostatMode') && !payload.state.hasOwnProperty('thermostatSetPoint')) {
					dev.state.thermostatMode = payload.state.thermostatMode;
				};
				if (payload.state.hasOwnProperty('thermostatSetPoint')) {
					if (dev.state.hasOwnProperty('thermostatSetPoint')) {
						var newMode;
						var newTemp = payload.state.thermostatSetPoint;
						// Get Supported Ranges and work-out new value for thermostatMode
						if (deviceJSON.attributes.hasOwnProperty('thermostatModes')){
							var countModes = deviceJSON.attributes.thermostatModes.length;
							var arrModes = deviceJSON.attributes.thermostatModes;
							// If single mode is supported leave as-is
							if (countModes == 1){
								newMode = dev.state.thermostatMode;
							}
							else {
								var auto = false;
								var heat = false;
								var cool = false;
								var on = false;
								var off = false;
								if (arrModes.indexOf('AUTO') > -1){auto = true};
								if (arrModes.indexOf('HEAT') > -1){heat = true};
								if (arrModes.indexOf('COOL') > -1){cool = true};
								if (arrModes.indexOf('ON') > -1){on = true};
								if (arrModes.indexOf('OFF') > -1){off = true};
								logger.log('debug', "[State API] thermostatSetPoint, modes: " + JSON.stringify(deviceJSON.attributes.thermostatModes) + ", countModes: " + countModes);
								// Supported combos
									// ON and OFF
									// HEAT and COOL
									// HEAT, COOl, AUTO
									// HEAT, COOl, AUTO, ON, OFF
								// Set dev.state.thermostatMode
								if (countModes == 2 && (on && off)) { // On and Off Supported
									if (newTemp < dev.state.thermostatSetPoint ) {newMode = "OFF"}
									else {newMode = "ON"}
								}
								else if (countModes == 2 && (heat && cool)) { // Cool and Heat Supported
									if (newTemp < dev.state.thermostatSetPoint ) {newMode = "COOL"}
									else {newMode = "HEAT"}
								}
								else if (countModes == 3 && (heat && cool && auto)) { // Heat, Cool and Auto Supported
									if (newTemp < dev.state.thermostatSetPoint ) {newMode = "COOL"}
									else {newMode = "HEAT"}
								}
								else if (countModes == 5 && (on && off && on && off && auto)) { // All Modes Supported
									if (newTemp < dev.state.thermostatSetPoint ) {newMode = "COOL"}
									else {newMode = "HEAT"}
								}
								else { // Fallback position
									newMode = "HEAT";
								}
								logger.log('debug', "[State API] thermostatSetPoint, newMode: " + newMode);
								logger.log('debug', "[State API] thermostatSetPoint, newTemp: " + newTemp);
							}
						}
						// Check within supported range of device
						if (deviceJSON.hasOwnProperty('attributes')) {
							if (deviceJSON.attributes.hasOwnProperty('temperatureRange')) {
								if (deviceJSON.attributes.temperatureRange.hasOwnProperty('temperatureMin') && deviceJSON.attributes.temperatureRange.hasOwnProperty('temperatureMax')) {
									if (!(newTemp < deviceJSON.attributes.temperatureRange.temperatureMin) || !(newTemp > deviceJSON.attributes.temperatureRange.temperatureMax)) {
										dev.state.thermostatSetPoint = newTemp;
										dev.state.thermostatMode = newMode;
									}
								}

							}
						}
					}
				}
				if (payload.state.hasOwnProperty('volume')) {dev.state.volume = payload.state.volume}
				if (payload.state.hasOwnProperty('volumeDelta')) {
					if (dev.state.hasOwnProperty('volume')) {
						var newVolume = dev.state.volume + payload.state.volumeDelta;
						dev.state.volume = newVolume;
					}
				}
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
						if (gHomeReportState == true || alexaReportState == true) {
							var pUser = Account.findOne({username: username});
							var pDevice = Devices.findOne({username: username, endpointId: endpointId});
							Promise.all([pUser, pDevice]).then(([user, device]) => {
								///////////////////////////////////////////////////////////////////////////
								// Google Home
								///////////////////////////////////////////////////////////////////////////
								isGhomeUser(user, function(returnValue) { // Check user is has linked account w/ Google
									if (returnValue == true && gHomeReportState == true) {
										try {
											logger.log('debug', "[State API] GHome Report State using device:" + JSON.stringify(device));
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
														logger.log('debug', "[State API] Generated GHome state report: " + JSON.stringify(stateReport));

														if (gToken != undefined) {
															logger.log('verbose', '[State API] Calling Send State with gToken:' + JSON.stringify(gToken));
															gHomeSendState(gToken, stateReport);
														}
														else {logger.log('verbose', '[State API] Unable to call Send State, no token, gToken value:' + JSON.stringify(gToken))}
													}
												}
											});											
										}
										catch (e) {logger.log('debug', "[State API] gHomeSendState error: " + e)};
									}
									else {
										if (returnValue == false){logger.log('debug', "[State API] User:" + username + ", is not a Google Home user")};
										if (gHomeReportState == false){logger.log('debug', "[State API] GHome state reporting DISABLED")};
									}
								});
								///////////////////////////////////////////////////////////////////////////
								// Alexa
								///////////////////////////////////////////////////////////////////////////
								isAlexaUser(user, function(returnValue) {
									if (returnValue == true && alexaReportState == true) {
										try {
											logger.log('debug', "[State API] Alexa Change report using device:" + JSON.stringify(device));
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
																token: accesstoken.token
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
													logger.log('debug', "[State API] Generated Alexa Change Report: " + JSON.stringify(changeReport));
													alexaSendState(user, changeReport);
												}
											});
										}
										catch (e) {logger.log('debug', "[State API] alexaSendState error: " + e)}
									}
									else {
										if (returnValue == false){logger.log('debug', "[State API] User:" + username + ", is not an Alexa user")};
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
