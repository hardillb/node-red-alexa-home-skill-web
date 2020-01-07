///////////////////////////////////////////////////////////////////////////
// Depends
///////////////////////////////////////////////////////////////////////////
const mqtt = require('mqtt');
const logger = require('./logger'); // Moved to own module
const updateDeviceState = require('../services/state').updateDeviceState;
///////////////////////////////////////////////////////////////////////////
// Variables
///////////////////////////////////////////////////////////////////////////
// MQTT ENV variables========================
var mqtt_user = (process.env.MQTT_USER);
var mqtt_password = (process.env.MQTT_PASSWORD);
var mqtt_port = (process.env.MQTT_PORT || "1883");
var mqtt_url = (process.env.MQTT_URL || "mqtt://mosquitto:" + mqtt_port);
// Shared Array Object for Alexa/ GHome Commands that are un-acknowledged
var ongoingCommands = {};
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

mqttClient = mqtt.connect(mqtt_url, mqttOptions);

mqttClient.on('error',function(err){
	logger.log('error', "[MQTT] MQTT connect error");
});
mqttClient.on('reconnect', function(){
	logger.log('warn', "[MQTT] MQTT reconnect event");
});
mqttClient.on('connect', function(){
	logger.log('info', "[MQTT] MQTT connected, subscribing to 'response/#' and 'state/#'")
	mqttClient.subscribe('response/#');
	mqttClient.subscribe('state/#');
});
///////////////////////////////////////////////////////////////////////////
// MQTT Message Handlers
///////////////////////////////////////////////////////////////////////////
// Event handler for received MQTT messages - note subscribe near top of script.
mqttClient.on('message',function(topic,message){
	var arrTopic = topic.split("/");
	var username = arrTopic[1];
	var endpointId = arrTopic[2];
	var payload = JSON.parse(message.toString());
	var commandSource = undefined;

	// Alexa uses messageId, GHome uses payload.messageId + endpointId as commands can contain multiple devices, this allows for collation
	var commandWaiting = (ongoingCommands[payload.messageId] || ongoingCommands[payload.messageId + endpointId]);

	if (commandWaiting && commandWaiting.hasOwnProperty('source')){
		var commandSource = JSON.stringify(commandWaiting.source);
		commandSource = commandSource.replace(/['"]+/g, '');
	}

	if (commandWaiting && commandSource == "Google" && topic.startsWith('response/')) {
		if (payload.success) {
			// Check if command had >1 target device, if so we need to ensure all commands are successful
			var arrCommandDevices =  commandWaiting.devices;
			///////////////////////////////////////////////////////////////////////////
			// Multi-device command, perform correlation of responses
			///////////////////////////////////////////////////////////////////////////
			if (Array.isArray(arrCommandDevices) && arrCommandDevices.length !== 0 ){
				// Mark this command as acknowledged/ successful as we have a response for it
				delete ongoingCommands[payload.messageId + endpointId].acknowledged;
				ongoingCommands[payload.messageId + endpointId].acknowledged = true;
				//logger.log('debug', "[GHome API] Updated waiting command acknowledged: " + JSON.stringify(ongoingCommands[payload.messageId + endpointId].acknowledged))
				// Add endpointId to response (if it isn't already there)
				if (commandWaiting.response.payload.commands[0].ids.includes(endpointId) == false){
					ongoingCommands[payload.messageId + endpointId].response.payload.commands[0].ids.push(endpointId);
				}
				// Check for other commands, and that all are acknowledged
				var sendResponse = true;
				for (x = 0; x < arrCommandDevices.length; x++) {
					var additionalCommand = ongoingCommands[payload.messageId + arrCommandDevices[x]];
					// Check that endpointId hasn't already been added to response
					if (additionalCommand) {
						//logger.log('debug', "[GHome API] Found Additional Command")
						if (additionalCommand.hasOwnProperty('acknowledged') && commandWaiting.response.payload.commands[0].ids.includes(arrCommandDevices[x]) == false){
							// Add successful command endpointId to response and delete the additionalCommand that is waiting
							// Essentially we should get down to a single acknowledged waiting command with deviceIds in response that have successfully executed the command
							if (additionalCommand.acknowledged == true) {
								ongoingCommands[payload.messageId + endpointId].response.payload.commands[0].ids.push(arrCommandDevices[x]);
								// Delete/ clean-up duplicate command response
								delete ongoingCommands[additionalCommand.requestId + arrCommandDevices[x]];
								logger.log('debug', "[MQTT] Merged *acknowledged* GHome multi-device command response: " + username +  ", ***updated*** response: " + JSON.stringify(commandWaiting.response));
							}
							// This additional command is yet to be acknowledged via MQTT response from Node-RED
							else {
								logger.log('debug', "[MQTT] GHome multi-device command *not* acknowledged: " + username +  ", ***un-modified*** response: " + JSON.stringify(commandWaiting.response));
								sendResponse = false;
							}
						}
						else {
							sendResponse = false;
						}
					}
				}
				// All commands in multi-device command have been executed successfully
				if (sendResponse == true) {
					logger.log('debug', "[MQTT] Successful GHome multi-device command for user: " + username +  ", response: " + JSON.stringify(commandWaiting.response));
					try {
						// Multi-devices this generates an error as res is sent after first device
						commandWaiting.res.status(200).json(commandWaiting.response);
						delete ongoingCommands[payload.messageId + endpointId];
					}
					catch(e) {
						logger.log('warn', "[MQTT] GHome send response error: " + e);
					}
				}

			}
			///////////////////////////////////////////////////////////////////////////
			// Single-device command
			///////////////////////////////////////////////////////////////////////////
			else {
				try {
					commandWaiting.res.status(200).json(commandWaiting.response);
					logger.log('debug', "[MQTT] Successful GHome MQTT command for user: " + username +  ", response: " + JSON.stringify(commandWaiting.response));
					delete ongoingCommands[payload.messageId + endpointId];
				}
				catch(e) {
					logger.log('warn', "[MQTT] GHome send response error: " + e);
				}
			}
		}
		else {
			logger.log('debug', "[MQTT] GHome MQTT response message is failure for topic: " + topic);
			// Google Home failure response
			if (commandWaiting.hasOwnProperty('source')) {
				var commandSource = JSON.stringify(commandWaiting.source);
				commandSource = commandSource.replace(/['"]+/g, '');
				if (commandSource == "Google") {
					// Change response to FAILED
					delete commandWaiting.response.state;
					commandWaiting.response.status = "FAILED";
					// Send Response
					logger.log('warn', "[MQTT] Failed GHome MQTT command for user: " + username + ", response: " + JSON.stringify(commandWaiting.response));
					try {
						commandWaiting.res.status(200).json(commandWaiting.response);
					}
					catch(e) {
						logger.log('warn', "[MQTT] Error sending GHome failed command response for user: " + username + ", error: " + e);
					}
					delete ongoingCommands[payload.messageId + endpointId];
				}
			}
		}
	}
	/// End GHome Response
	/// Start Alexa Response
	else if (commandWaiting && commandSource == "Alexa" && topic.startsWith('response/')) {
		logger.log('info', "[MQTT] Acknowledged Alexa MQTT response message for topic: " + topic);
		if (payload.success) {
			//logger.log('debug', "[Alexa API] MQTT response message is success for topic: " + topic);
			// Alexa success response send to Lambda for full response construction
			if (commandWaiting.hasOwnProperty('response')) {
				logger.log('debug', "[MQTT] Successful Alexa MQTT command for user: " + username + ", response: " + JSON.stringify(commandWaiting.response));
				commandWaiting.res.status(200).json(commandWaiting.response)
				delete ongoingCommands[payload.messageId];
			}
			else {
				logger.log('debug', "[MQTT] Successful Alexa MQTT command for user: " + username);
				commandWaiting.res.status(200).send()
				delete ongoingCommands[payload.messageId];
			}
		}
		else {
			// Alexa failure response send to Lambda for full response construction
			if (commandWaiting.hasOwnProperty('source')) {
				var commandSource = JSON.stringify(commandWaiting.source);
				commandSource = commandSource.replace(/['"]+/g, '');
				if (commandSource == "Alexa") {
					if (commandWaiting.hasOwnProperty('response')) {
						logger.log('warn', "[MQTT] Failed Alexa MQTT Command for user: " + username + ", response: " + + JSON.stringify(commandWaiting.response));
						commandWaiting.res.status(503).json(commandWaiting.response)
						delete ongoingCommands[payload.messageId];
					}
					else {
						logger.log('warn', "[MQTT] Failed Alexa MQTT Command for user: " + username);
						commandWaiting.res.status(503).send()
						delete ongoingCommands[payload.messageId];
					}
				}
			}
		}
	}
	/// End Alexa Response
	/// Start State Handler
	else if (topic.startsWith('state/')){
		//logger.log('info', "[State API] Acknowledged MQTT state message topic: " + topic);
		logger.log('info', "[MQTT] Acknowledged MQTT State message for user: " + username + ", message: " + message);
		// Split topic/ get username and endpointId
		var messageJSON = JSON.parse(message);
		var payload = messageJSON.payload;
		// Call updateDeviceState to update state element in mongodb
		updateDeviceState(username, endpointId, payload) //arrTopic[1] is username, arrTopic[2] is endpointId
			.then(result => {
				if (result == true) {
					logger.log('verbose', "[MQTT] Successfully updated state for user: " + username + ", endpointId: " + endpointId);
				}
				else if (Array.isArray(result)){
					result.forEach(message => {
						notifyUser('warn', username, endpointId, message);
					});
				}
				else if (result == false){
					logger.log('warn', "[MQTT] Failed to updated state for user: " + username + ", endpointId: " + endpointId);
				}
			})
			.catch(e => {
				logger.log('error', "[MQTT] Error trying to update state for user: " + username + ", endpointId: " + endpointId + ", error" + e.stack);
			});
	}
	else {
		logger.log('debug', "[MQTT] Unhandled MQTT message event: " + topic + message);
	}
});

///////////////////////////////////////////////////////////////////////////
// Timer
///////////////////////////////////////////////////////////////////////////
var timeout = setInterval(function(){
	var now = Date.now();
	var maxTime = 2000;
	var keys = Object.keys(ongoingCommands);

	for (key in keys){
		var waiting = ongoingCommands[keys[key]];

		if (waiting && waiting.hasOwnProperty('source')){
			var commandSource = JSON.stringify(waiting.source);
			commandSource = commandSource.replace(/['"]+/g, '');
		}

		if (waiting && waiting.source == "Alexa") {
			var diff = now - waiting.timestamp;
			if (diff > maxTime) {
				try {
					waiting.res.status(504).send('{"error": "timeout"}');
					logger.log('warn', "[MQTT] Sent Alexa time-out response for user: " + waiting.user + ", message: " + keys[key]);
				}
				catch(e) {
					logger.log('error', "[MQTT] Error sending Alexa timeout response, error: " + e);
				}

				//logger.log('warn', "[MQTT] MQTT command timed out/ unacknowledged for user: " + waiting.user + ", message: " + keys[key]);
				delete ongoingCommands[keys[key]];
				//measurement.send({
				//	t:'event',
				//	ec:'command',
				//	ea: 'timeout',
				//	uid: waiting.user
				//});
			}
		}
		else if (waiting && waiting.source == "Google") {
			var diff = now - waiting.timestamp;
			if (diff > maxTime) {
				//logger.log('warn', "[MQTT] MQTT command timed out/ unacknowledged: " + keys[key]);
				var arrCommandDevices =  waiting.devices;
				///////////////////////////////////////////////////////////////////////////
				// Multi-device command, perform correlation of responses
				///////////////////////////////////////////////////////////////////////////
				// Check for other commands, should only find one as we've cleaned up further up
				//var sendResponse = true;
				var response = undefined;
				if (Array.isArray(arrCommandDevices) && arrCommandDevices.length !== 0 ){
					logger.log('debug', "[MQTT] Multi-device GHome command waiting");
					// If this command is acknowledged set response to this waiting command
					if (waiting.acknowledged == true){response = waiting.response};
					// Check for linked commands with same referenceId in ongoingCommands
					for (x = 0; x < arrCommandDevices.length; x++) {
						var additionalCommand = ongoingCommands[waiting.requestId + arrCommandDevices[x]];
						if (additionalCommand) {
							if (additionalCommand.hasOwnProperty('acknowledged') && additionalCommand.acknowledged == true) {
								// Logger.log('debug', "[GHome API] Found command waiting, multi-device command acknowledged!");
								if (response == undefined){response = additionalCommand.response}
								else if (response.payload.commands[0].ids.includes(arrCommandDevices[x]) == false){response.payload.commands[0].ids.push(arrCommandDevices[x])}
								// Cleanup waiting acknowledge command response, we're ready to send it
								delete ongoingCommands[additionalCommand.requestId + arrCommandDevices[x]];
							}
							// If we have a response, we can delete unacknowledged command older than > maxTime in ms
							var diffAdditionalCommand = now - additionalCommand.timestamp;
							if (diffAdditionalCommand > maxTime && response !== undefined) {delete ongoingCommands[additionalCommand.requestId + arrCommandDevices[x]];}
						}
					}
					// All commands in multi-device command have been executed successfully
					if (response !== undefined) {
						logger.log('debug', "[MQTT] Successful GHome multi-device command, response: " + JSON.stringify(waiting.response));
						try {
							// Multi-devices this generates an error as res is sent after first device
							waiting.res.status(200).json(response);
							delete ongoingCommands[keys[key]];
						}
						catch(e) {
							logger.log('warn', "[MQTT] Send multi-command GHome response error: " + e);
							delete ongoingCommands[keys[key]];
						}
					}
					// No acknowledged commands, so send timeout
					else {
						logger.log('debug', "[MQTT] GHome multi-device command timed-out");
						try {
							waiting.res.status(504).send('{"error": "timeout"}');
							delete ongoingCommands[keys[key]];
						}
						catch(e) {
							logger.log('debug', "[MQTT] GHome multi-device command timed-out, unable to send result, error: " + e);
							delete ongoingCommands[keys[key]];
						}
					}
				}
				///////////////////////////////////////////////////////////////////////////
				// Single device command, perform correlation of responses
				///////////////////////////////////////////////////////////////////////////
				else {
					try {
						waiting.res.status(504).send('{"error": "timeout"}');
						logger.log('debug', "[MQTT] GHome MQTT command timed-out");
						delete ongoingCommands[keys[key]];
					}
					catch(e) {
						logger.log('debug', "[MQTT] GHome single-device command timed-out, unable to send result, error: " + e);
						delete ongoingCommands[keys[key]];
					}

					//measurement.send({
					//	t:'event',
					//	ec:'command',
					//	ea: 'timeout',
					//	uid: waiting.user
					//});
				}
			}
		}
		else {
			// Add cleanup for any misc. entries in ongoingCommands, there shouldn't be any!
			// delete ongoingCommands[keys[key]];
		}
	}
},500);

// Post MQTT message that users' Node-RED instance will display in GUI as warning
function notifyUser(severity, username, endpointId, message){
	var topic = "message/" + username + "/" + endpointId; // Prepare MQTT topic for client-side notifications
	var alert = {
		"severity" : severity,
		"message" : message
	}
	var alertString = JSON.stringify(alert);
	try {
		logger.log('debug', "[MQTT] Publishing MQTT alert, topic: " + topic + ", alert: " + alertString);
		mqttClient.publish(topic,alertString);
		logger.log('warn', "[MQTT] Published MQTT alert for user: " + username + " endpointId: " + endpointId + " message: " + alertString);
	} catch (err) {
		logger.log('error', "[MQTT] Failed to publish MQTT alert, error: " + err.stack);
	}
};

module.exports = {
	mqttClient,
 	ongoingCommands
}