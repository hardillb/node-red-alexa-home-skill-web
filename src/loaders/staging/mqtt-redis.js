

////////////////// Not in use.... yet


///////////////////////////////////////////////////////////////////////////
// Depends
///////////////////////////////////////////////////////////////////////////
//var express = require('express');
//var router = express.Router();
const mqtt = require('mqtt');
const logger = require('../logger'); // Moved to own module
const client = require('./redis-mqtt'); // Redis MQTT Command Holding Area
const redisScan = require('node-redis-scan');
const hgetAsync = promisify(client.hget).bind(client);
const delAsync = promisify(client.del).bind(client);
const setAsync = promisify(client.set).bind(client);

const scanner = new redisScan(client);
///////////////////////////////////////////////////////////////////////////
// Variables
///////////////////////////////////////////////////////////////////////////
//var debug = (process.env.ALEXA_DEBUG || false);
// MQTT ENV variables========================
var mqtt_user = (process.env.MQTT_USER);
var mqtt_password = (process.env.MQTT_PASSWORD);
var mqtt_port = (process.env.MQTT_PORT || "1883");
var mqtt_url = (process.env.MQTT_URL || "mqtt://mosquitto:" + mqtt_port);
///////////////////////////////////////////////////////////////////////////
// MQTT Client Configuration
///////////////////////////////////////////////////////////////////////////
var mqttOptions = {
	connectTimeout: 30 * 1000,
	reconnectPeriod: 1000,
	keepAlive: 10,
	clean: true,
	resubscribe: true,
    clientId: 'NRSmartHome_' + Math.random().toString(16).substr(2, 8),
    username: mqtt_user,
    password: mqtt_password
};
///////////////////////////////////////////////////////////////////////////
// MQTT Connection
///////////////////////////////////////////////////////////////////////////
logger.log('info', "[MQTT] Connecting to MQTT server: " + mqtt_url);

var mqttClient = mqtt.connect(mqtt_url, mqttOptions);

mqttClient.on('error',function(err){
	logger.log('error', "[MQTT] MQTT connect error");
});
mqttClient.on('reconnect', function(){
	logger.log('warn', "[MQTT] MQTT reconnect event");
});
mqttClient.on('connect', function(){
	logger.log('info', "[MQTT] MQTT connected, subscribing to 'response/#'")
	mqttClient.subscribe('response/#');
});
///////////////////////////////////////////////////////////////////////////
// MQTT Message Handlers
///////////////////////////////////////////////////////////////////////////

// Event handler for received MQTT messages - note subscribe near top of script.
mqttClient.on('message',function(topic,message){
	var arrTopic = topic.split("/");
	var username = arrTopic[1];
	var endpointId = arrTopic[2];

	if (topic.startsWith('response/')){
		var payload = JSON.parse(message.toString());
		var commandSource = undefined;
		var sendResponse = true;

		// ###### Need to Have endpointId in find ####### - modify function that if not returned try with endpointId as well
		readCommandAsync(payload.messageId)
			// Handle Alexa-related Commands in Redis
			.then(commandWaiting => {
				if (payload.success) {
					// Alexa success response send to Lambda for full response construction
					if (commandWaiting.hasOwnProperty('source')) {
						commandSource = JSON.stringify(commandWaiting.source);
						commandSource = commandSource.replace(/['"]+/g, '');
						///////////////////////////////////////////////////////////////////////////
						// Alexa-related MQTT Message Handlers
						///////////////////////////////////////////////////////////////////////////
						if (commandSource == "Alexa") {
							// Send expected Alexa API Response
							if (commandWaiting.hasOwnProperty('response')) {
								logger.log('debug', "[MQTT] Successful Alexa MQTT command for user: " + username + ", response: " + JSON.stringify(commandWaiting.response));
								commandWaiting.res.status(200).json(commandWaiting.response)
							}
							// Send Status 200 ??
							else {
								logger.log('debug', "[MQTT] Successful Alexa MQTT command for user: " + username);
								commandWaiting.res.status(200).send()
							}
						}
					}
				}
				else {
					// Send Failure Response
					if (commandWaiting.hasOwnProperty('source')) {
						commandSource = JSON.stringify(commandWaiting.source);
						commandSource = commandSource.replace(/['"]+/g, '');
						///////////////////////////////////////////////////////////////////////////
						// Alexa-related MQTT Message Handlers
						///////////////////////////////////////////////////////////////////////////
						if (commandSource == "Alexa") {
							if (commandWaiting.hasOwnProperty('response')) {
								logger.log('warn', "[Alexa API] Failed Alexa MQTT Command for user: " + username + ", response: " + + JSON.stringify(commandWaiting.response));
								commandWaiting.res.status(503).json(commandWaiting.response)
							}
							else {
								logger.log('warn', "[Alexa API] Failed Alexa MQTT Command for user: " + username);
								commandWaiting.res.status(503).send()
							}
						}
						///////////////////////////////////////////////////////////////////////////
						// Google-related MQTT Message Handlers
						///////////////////////////////////////////////////////////////////////////
						if (commandSource == "Google") {
							// Change response to FAILED
							delete commandWaiting.response.state;
							commandWaiting.response.status = "FAILED";
							// Send Response
							logger.log('warn', "[GHome API] Failed Google Home MQTT command for user: " + username + ", response: " + JSON.stringify(commandWaiting.response));
							try {
								commandWaiting.res.status(200).json(commandWaiting.response);
							}
							catch(e) {
								logger.log('warn', "[GHome API] Error sending failed command response for user: " + username + ", error: " + e);
							}
							delAsync(payload.messageId + endpointId)
						}
					}
				}
			})
			// Handle GHome-related Commands in Redis
			.then(commandWaiting => {
				if (payload.success) {
					// Alexa success response send to Lambda for full response construction
					if (commandWaiting.hasOwnProperty('source')) {
						commandSource = JSON.stringify(commandWaiting.source);
						commandSource = commandSource.replace(/['"]+/g, '');
					}

					///////////////////////////////////////////////////////////////////////////
					// Google-related MQTT Message Handlers
					///////////////////////////////////////////////////////////////////////////
					if (commandSource == "Google") {
						// Check if command had >1 target device, if so we need to ensure all commands are successful
						var arrCommandDevices =  commandWaiting.devices;
						// Mark this command as acknowledged/ successful as we have a response for it
						delete commandWaiting.acknowledged;
						commandWaiting.acknowledged = true;

						///////////////////////////////////////////////////////////////////////////
						// Multi-device command, perform correlation of responses
						///////////////////////////////////////////////////////////////////////////
						if (Array.isArray(arrCommandDevices) && arrCommandDevices.length !== 0 ){
							//logger.log('debug', "[GHome API] Google Home multi-device command response for user: " + username +  ", ***existing*** response: " + JSON.stringify(commandWaiting.response));
							//logger.log('debug', "[GHome API] Google Home multi-device command response for user: " + username +  ", additional devices: " + JSON.stringify(commandWaiting.devices));

							// Add endpointId to response (if it isn't already there)
							if (commandWaiting.response.payload.commands[0].ids.includes(endpointId) == false){
								// Update command waiting to include endpointId
								commandWaiting.response.payload.commands[0].ids.push(endpointId);
							}

							// Check for other commands, and that all are acknowledged
							// Overwrite REDIS stored command waiting to include endpointId
							setAsync(payload.messageId + endpointId, commandWaiting)
								.then(result => {
									for (x = 0; x < arrCommandDevices.length; x++) {
										//logger.log('debug', "[GHome API] Trying to match inbound response, messageId: " + payload.messageId + ", with additional endpointId: " + arrCommandDevices[x])
										//logger.log('debug', "[GHome API] Looking for waiting command with key: " + payload.messageId + arrCommandDevices[x])
										readCommandAsync(payload.messageId)
											.then(additionalCommand => {
												if (additionalCommand.hasOwnProperty('acknowledged') && commandWaiting.response.payload.commands[0].ids.includes(arrCommandDevices[x]) == false){
													// Essentially we should get down to a single acknowledged waiting command with deviceIds in response that have successfully executed the command
													if (additionalCommand.acknowledged == true) {
														// Add successful command endpointId to response and delete the additionalCommand that is waiting
														commandWaiting.response.payload.commands[0].ids.push(arrCommandDevices[x]);
														setAsync(payload.messageId + endpointId, commandWaiting);
														// Delete/ clean-up duplicate command response
														delAsync(additionalCommand.requestId + arrCommandDevices[x]);
														logger.log('debug', "[GHome API] Merged *acknowledged* multi-device command response: " + username +  ", ***updated*** response: " + JSON.stringify(commandWaiting.response));
													}
													// This additional command is yet to be acknowledged via MQTT response from Node-RED
													else {
														logger.log('debug', "[GHome API] Google Home multi-device command *not* acknowledged: " + username +  ", ***un-modified*** response: " + JSON.stringify(commandWaiting.response));
														sendResponse = false;
													}
												}
												else {
													sendResponse = false;
												}
											});
									}
								});
						}
						///////////////////////////////////////////////////////////////////////////
						// Single-device command
						///////////////////////////////////////////////////////////////////////////
						else {
							try {
								commandWaiting.res.status(200).json(commandWaiting.response);
								logger.log('debug', "[GHome API] Successful Google Home MQTT command for user: " + username +  ", response: " + JSON.stringify(commandWaiting.response));
								delAsync(payload.messageId + endpointId);
							}
							catch(e) {
								logger.log('warn', "[GHome API] Warning: " + e);
							}
						}

					}
				}

			})
			.then(commandWaiting => {
				// All commands in multi-device command have been executed successfully
				if (commandSource == "Google" && sendResponse == true) {
					logger.log('debug', "[GHome API] Successful Google Home multi-device command for user: " + username +  ", response: " + JSON.stringify(commandWaiting.response));
					try {
						// Multi-devices this generates an error as res is sent after first device
						commandWaiting.res.status(200).json(commandWaiting.response);
						delAsync(payload.messageId + endpointId);
					}
					catch(e) {
						logger.log('warn', "[GHome API] Warning: " + e);
					}
				}
			})
			.catch(err => {
				delAsync(payload.messageId + endpointId)
			})
	}
	if (topic.startsWith('state/')){
		//logger.log('info', "[State API] Acknowledged MQTT state message topic: " + topic);
		logger.log('info', "[State API] Acknowledged MQTT state message for user: " + username + ", message: " + message);
		// Split topic/ get username and endpointId
		var messageJSON = JSON.parse(message);
		var payload = messageJSON.payload;
		// Call setstate to update attribute in mongodb
		setstate(username,endpointId,payload) //arrTopic[1] is username, arrTopic[2] is endpointId
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
	var maxTime = 2000;
	// Use redis-scan to iterate through ALL keys (should be few due to 20 second expiry set on DB1 keys)
	scanner.hscan('command', '*', (err, matchingKeysValues) => {
		if (err) return done(err);
		// matchingKeysValues will be an array of strings if matches were found
		// in the hash, otherwise it will be an empty array.
		console.log(matchingKeysValues);
	});

	// Use 'keys' object for read/ write operations, ensure changes are save/ deletions are made to redis itself
	scanner.hscan('command', '*', (err, keys) => {
		if (err) throw(err);
		for (key in keys){
			// Create fresh response object
			var response = undefined;
			var commandSource = undefined;
			readCommandAsync(key)
				// Handle Alexa-related Commands in Redis
				.then(waiting => {
					logger.log('debug', "[MQTT] Unacknowledged Alexa command message for user: " + waiting.user + ", message: " + waiting);
					var diff = now - waiting.timestamp;
					if (diff > 2000) {
						if (waiting.hasOwnProperty('source')){
							commandSource = JSON.stringify(waiting.source);
							commandSource = commandSource.replace(/['"]+/g, '');
							// Alexa Commands are sent individually, no need to potentially send partial response
							if (commandSource == "Alexa") {
								waiting.res.status(504).send('{"error": "timeout"}');
								delAsync(key);
							}
						}
					}
				})
				// Handle GHome-related Commands in Redis
				.then(waiting => {
					logger.log('debug', "[MQTT] Unacknowledged GHome command message for user: " + waiting.user + ", message: " + waiting);
					if (diff > 2000) {
						if (waiting.hasOwnProperty('source')){
							commandSource = JSON.stringify(waiting.source);
							commandSource = commandSource.replace(/['"]+/g, '');
							if (commandSource == "Google") {
								//logger.log('warn', "[MQTT] MQTT command timed out/ unacknowledged: " + keys[key]);
								///////////////////////////////////////////////////////////////////////////
								// Multi-device command, perform correlation of responses
								///////////////////////////////////////////////////////////////////////////
								if (Array.isArray(arrCommandDevices) && arrCommandDevices.length !== 0 ){
									logger.log('debug', "[MQTT] GHome Multi-device command waiting");
									// If this command is acknowledged set response to this waiting command
									if (waiting.acknowledged == true){response = waiting.response};
									// Check for linked commands with same referenceId in redis
									for (x = 0; x < arrCommandDevices.length; x++) {
										readAsync(waiting.requestId + arrCommandDevices[x])
											.then(additionalCommand => {
												if (additionalCommand.hasOwnProperty('acknowledged') && additionalCommand.acknowledged == true) {
													// Logger.log('debug', "[GHome API] Found command waiting, multi-device command acknowledged!");
													if (response == undefined){
														response = additionalCommand.response
													}
													else if (response.payload.commands[0].ids.includes(arrCommandDevices[x]) == false){
														response.payload.commands[0].ids.push(arrCommandDevices[x])
													}
													// Cleanup waiting acknowledge command response, we're ready to send it
													delAsync(additionalCommand.requestId + arrCommandDevices[x]);
												}
												// If we have a response, we can delete unacknowledged command older than > maxTime in ms
												var diffAdditionalCommand = now - additionalCommand.timestamp;
												if (diffAdditionalCommand > maxTime && response !== undefined) {
													delAsync(additionalCommand.requestId + arrCommandDevices[x])
												}
											})
											.catch(err => {
												logger.log('error', "[MQTT] Error reading GHome additional command data from Redis, error message: " + err );
											})
									}
								}
							}
						}
					}
				})
				// Send Google Home Response
				.then(waiting => {
					// All commands in multi-device command have been executed successfully
					if (commandSource == "Google" && response !== undefined) {
						logger.log('debug', "[MQTT] Partial success GHome multi-device command, response: " + JSON.stringify(waiting.response));
						try {
							// Multi-devices this generates an error as res is sent after first device
							waiting.res.status(200).json(response);
							delAsync(key);
						}
						catch(e) {
							logger.log('warn', "[MQTT] Send GHome multi-command response error: " + e);
							delAsync(key);
						}
					}
					// No acknowledged commands, so send timeout
					else if (commandSource == "Google" && response == undefined) {
						logger.log('debug', "[MQTT] GHome device command timed-out");
						try {
							waiting.res.status(504).send('{"error": "timeout"}');
							delAsync(key);
						}
						catch(e) {
							logger.log('debug', "[MQTT] GHome command timed-out, unable to send result, error: " + e);
							delAsync(key);
						}
					}
				})
				.catch(err => {
					logger.log('warn', "[MQTT] Redis get failed with error: " + err);
				})
		}
	});
},500);


///////////////////////////////////////////////////////////////////////////
// Async
///////////////////////////////////////////////////////////////////////////
const readCommandAsync = async(id) => {
	var data = await hgetAsync(id, 'command');
	return data;
}

module.exports = mqttClient;