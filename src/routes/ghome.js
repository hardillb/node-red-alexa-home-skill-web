///////////////////////////////////////////////////////////////////////////
// Depends
///////////////////////////////////////////////////////////////////////////
var express = require('express');
var router = express.Router();
var bodyParser = require('body-parser');
router.use(bodyParser.urlencoded({ extended: true }));
router.use(bodyParser.json());
var Account = require('../models/account');
var oauthModels = require('../models/oauth');
var Devices = require('../models/devices');
var passport = require('passport');
var mqttClient = require('../loaders/mqtt').mqttClient;
var ongoingCommands = require('../loaders/mqtt').ongoingCommands;
var logger = require('../loaders/logger');
const gHomeFunc = require('../services/func-ghome');
const gHomeReplaceCapability = require('../services/func-ghome').gHomeReplaceCapability;
const gHomeReplaceType = require('../services/func-ghome').gHomeReplaceType;
const servicesFunc = require('../services/func-services');
//var client = require('../loaders/redis-mqtt'); // Redis MQTT Command Holding Area
const defaultLimiter = require('../loaders/limiter').defaultLimiter;
//const sendPageView = require('../services/ganalytics').sendPageView;
//const sendPageViewUid = require('../services/ganalytics').sendPageViewUid;
const sendEventUid = require('../services/ganalytics').sendEventUid;
///////////////////////////////////////////////////////////////////////////
// Functions
///////////////////////////////////////////////////////////////////////////
const queryDeviceStateAsync = gHomeFunc.queryDeviceStateAsync;
const updateUserServices = servicesFunc.updateUserServices;
const removeUserServices = servicesFunc.removeUserServices;
///////////////////////////////////////////////////////////////////////////
// Variables
///////////////////////////////////////////////////////////////////////////
//var debug = (process.env.ALEXA_DEBUG || false);
///////////////////////////////////////////////////////////////////////////
// Main GHome Action API
///////////////////////////////////////////////////////////////////////////
// Removed basic auth, original line: passport.authenticate(['bearer', 'basic'], { session: false }),
router.post('/action', defaultLimiter,
	passport.authenticate('bearer', { session: false }),
	async (req, res) => {
	logger.log('verbose', "[GHome API] Request:" + JSON.stringify(req.body));
	var intent = req.body.inputs[0].intent;
	var requestId = req.body.requestId;
	var serviceName = "Google"; // As user has authenticated, assume activeService
	if (!req.user.activeServices || (req.user.activeServices && req.user.activeServices.indexOf(serviceName)) == -1) {updateUserServices(req.user.username, serviceName)};
		// All Google Home actions come in on a single route, we switch them based upon req.body.inputs[0].intent
	switch (intent) {
		///////////////////////////////////////////////////////////////////////////
		// SYNC
		///////////////////////////////////////////////////////////////////////////
		case 'action.devices.SYNC' :
			try {
				logger.log('verbose', "[GHome Sync API] Running device discovery for user: " + req.user.username);
				sendEventUid(req.path, "SYNC", "GHome SYNC Event", req.ip, req.user.username, req.headers['user-agent']);
				// Find associated user for command
				var user = await Account.find({username: req.user.username});
				// Find users devices
				var devices = await Devices.find({username: req.user.username});
				logger.log('debug', "[GHome Sync API] User: " + JSON.stringify(user[0]));
				// Build Device Array
				var devs = [];
				// For each user device, create Google-ified SYNC data
				for (let device of devices){
					var deviceJSON = JSON.parse(JSON.stringify(device));
					//logger.log('debug','[GHome Sync API] Building device data for device:' + JSON.stringify(device))
					var dev = {}
					dev.id = "" + device.endpointId;
					dev.type = await gHomeReplaceType(device.displayCategories);
					dev.traits = [];
					// Check supported device type
					if (dev.type != "NA") {
						// Check supported capability/ trait
						for (let capability of device.capabilities){
							var trait = await gHomeReplaceCapability(capability, dev.type);
							// Add supported traits, don't add duplicates
							if (trait != "Not Supported" && dev.traits.indexOf(trait) == -1){
								dev.traits.push(trait);
							}
						}
					}
					dev.name = {
						name : device.friendlyName
						}
					dev.willReportState = device.reportState;
					var hasAttributes = 'attributes' in deviceJSON;
					if (hasAttributes == true) {
						dev.attributes = device.attributes;
					}
					else {
						dev.attributes = {};
					}
					// Populate attributes, remap roomHint to device root
					if (deviceJSON.hasOwnProperty('attributes')) {
						if (deviceJSON.attributes.hasOwnProperty('roomHint')){
							delete dev.attributes.roomHint;
							if (deviceJSON.attributes.roomHint != ""){dev.roomHint = deviceJSON.attributes.roomHint};
						}
					}
					// Add colorModel attribute if color is supported interface/ trait
					if (device.capabilities.indexOf("ColorController") > -1 ){
						dev.attributes.colorModel = "hsv";
						delete dev.attributes.commandOnlyColorSetting; // defaults to false anyway
					}
					// Pass min/ max values as float
					if (device.capabilities.indexOf("ColorTemperatureController") > -1 ){
						dev.attributes.colorTemperatureRange.temperatureMinK = parseInt(dev.attributes.colorTemperatureRange.temperatureMinK);
						dev.attributes.colorTemperatureRange.temperatureMaxK = parseInt(dev.attributes.colorTemperatureRange.temperatureMaxK);
					}
					// FanSpeed, map 1:1 with RangeController 1-10
					if (device.capabilities.indexOf("RangeController") > -1 && (dev.type.indexOf('action.devices.types.FAN') > -1 || dev.type.indexOf('action.devices.types.THERMOSTAT') > -1 )){
						dev.attributes.availableFanSpeeds = {
							"availableFanSpeeds": {
							"speeds": [{
								"speed_name": "S1",
								"speed_values": [{
								"speed_synonym": ["low", "speed 1"],
								"lang": "en" }]
								},
								{
								"speed_name": "S2",
								"speed_values": [{
								"speed_synonym": ["speed 2"],
								"lang": "en" }]
								},
								{
								"speed_name": "S3",
								"speed_values": [{
								"speed_synonym": ["speed 3"],
								"lang": "en" }]
								},
								{
								"speed_name": "S4",
								"speed_values": [{
								"speed_synonym": ["speed 4"],
								"lang": "en" }]
								},
								{
								"speed_name": "S5",
								"speed_values": [{
								"speed_synonym": ["medium", "speed 5"],
								"lang": "en" }]
								},
								{
								"speed_name": "S6",
								"speed_values": [{
								"speed_synonym": ["speed 6"],
								"lang": "en" }]
								},
								{
								"speed_name": "S7",
								"speed_values": [{
								"speed_synonym": ["speed 7"],
								"lang": "en" }]
								},
								{
								"speed_name": "S8",
								"speed_values": [{
								"speed_synonym": ["speed 8"],
								"lang": "en" }]
								},
								{
								"speed_name": "S9",
								"speed_values": [{
								"speed_synonym": ["speed 9"],
								"lang": "en" }]
								},
								{
								"speed_name": "S10",
								"speed_values": [{
								"speed_synonym": ["high", "maximum", "speed 10"],
								"lang": "en" }]
								}],
							"ordered": true
							},
							"reversible": false
						}
					}
					// action.devices.traits.TemperatureSetting, adjust dev.attributes to suit Google Home
					if (dev.traits.indexOf("action.devices.traits.TemperatureSetting") > -1 ){
						// Is a HVAC unit, change device type accordingly
						// if (dev.attributes.thermostatModes.indexOf('COOL') > -1 && dev.type == 'action.devices.types.THERMOSTAT') {
						//  	dev.type = 'action.devices.types.AC_UNIT';
						// }
						dev.attributes.availableThermostatModes = dev.attributes.thermostatModes.join().toLowerCase(); // Make string, not array
						dev.attributes.thermostatTemperatureUnit = dev.attributes.temperatureScale.substring(0, 1); // >> Need to make this upper F or C, so trim
						delete dev.attributes.temperatureRange;
						delete dev.attributes.temperatureScale;
						delete dev.attributes.thermostatModes;
					}
					dev.deviceInfo = {
						manufacturer : "Node-RED",
						model : "Node-RED",
						hwVersion : "0.1",
						swVersion : "0.1"
					}
					// Limit supported traits, don't add other device types
					if (dev.traits.length > 0 && dev.type != "NA") {
						devs.push(dev);
					}
				}
				// Build Response
				var response = {
					"requestId": requestId,
					"payload": {
						"agentUserId": user[0]._id,
						"devices" : devs
					}
				}
				logger.log('verbose', "[GHome Sync API] Discovery Response for user: " + req.user.username + ", response: " + JSON.stringify(response));
				// Send Response
				res.status(200).json(response);
			}
			catch(e) {
				logger.log('error', "[GHome Sync API] error:" + e.stack)
				res.status(500).json({message: "An error occurred."});
			}
			break;
		///////////////////////////////////////////////////////////////////////////
		// EXECUTE
		///////////////////////////////////////////////////////////////////////////
		case 'action.devices.EXECUTE' :
			try {
				logger.log('verbose', "[GHome Exec API] Execute command(s) for user: " + req.user.username);
				sendEventUid(req.path, "EXECUTE", "GHome EXECUTE Event", req.ip, req.user.username, req.headers['user-agent']);
				// Find users devices
				var devices = await Devices.find({username: req.user.username});
				logger.log('debug', "[GHome Exec API] Execute command(s) for user: " + req.user.username + ", command: " +  JSON.stringify(req.body.inputs[0].payload.commands));
				// Array of commands, assume match with device array at same index?!
				var arrCommands = req.body.inputs[0].payload.commands;
				// Iterate through commands in payload, against each listed
				for (var i=0; i< arrCommands.length; i++) {
					var arrCommandsDevices =  req.body.inputs[0].payload.commands[i].devices; // Array of devices to execute commands against
					logger.log('debug', "[GHome Exec API] # of endpoints in command request: " + arrCommandsDevices.length);
					var params = arrCommands[i].execution[0].params; // Google Home Parameters
					var validationStatus = true;
					// Match device to returned array in case of any required property/ validation
					arrCommandsDevices.forEach(function(element) {
						//logger.log('debug', "[GHome Exec API] Attempting to matching command device: " + element.id + ", against devicesJSON");
						var data = devices.find(obj => obj.endpointId == element.id);
						if (data == undefined) {logger.log('debug', "[GHome Exec API] Failed to match device against devicesJSON")}
						else {logger.log('debug', "[GHome Exec API] Executing command against device:" + JSON.stringify(data))}
						///////////////////////////////////////////////////////////////////////////
						// Perform Command Validation
						///////////////////////////////////////////////////////////////////////////
						// Handle Thermostat valueOutOfRange
						if (arrCommands[i].execution[0].command == "action.devices.commands.ThermostatTemperatureSetpoint") {
							var hastemperatureMax = getSafe(() => data.attributes.temperatureRange.temperatureMax);
							var hastemperatureMin = getSafe(() => data.attributes.temperatureRange.temperatureMin);
							if (hastemperatureMin != undefined && hastemperatureMax != undefined) {
								var temperatureMin = data.attributes.temperatureRange.temperatureMin;
								var temperatureMax = data.attributes.temperatureRange.temperatureMax;
								logger.log('debug', "[GHome Exec API] Checking requested setpoint: " + params.thermostatTemperatureSetpoint + " , againast temperatureRange, temperatureMin:" + hastemperatureMin + ", temperatureMax:" + temperatureMax);
								if (params.thermostatTemperatureSetpoint > temperatureMax || params.thermostatTemperatureSetpoint < temperatureMin){
									// Build valueOutOfRange error response
									validationStatus = false;
									logger.log('warn', "[GHome Exec API] Temperature valueOutOfRange error for endpointId:" + element.id);
									// Global error response
									var errResponse = {
										"requestId": req.body.requestId,
										"payload": {
											"errorCode": "valueOutOfRange"
										}
									}
									logger.log('debug', "[GHome Exec API] valueOutOfRange error response:" + JSON.stringify(errResponse));
									res.status(200).json(errResponse);
								}
							}
						}
						// Handle Color Temperature valueOutOfRange
						if (arrCommands[i].execution[0].command == "action.devices.commands.ColorAbsolute") {
							var hastemperatureMaxK = getSafe(() => data.attributes.colorTemperatureRange.temperatureMaxK);
							var hastemperatureMinK = getSafe(() => data.attributes.colorTemperatureRange.temperatureMinK);
							if (hastemperatureMinK != undefined && hastemperatureMaxK != undefined) {
								var temperatureMinK = data.attributes.colorTemperatureRange.temperatureMinK;
								var temperatureMaxK = data.attributes.colorTemperatureRange.temperatureMaxK;
								logger.log('debug', "[GHome Exec API] Checking requested setpoint: " + params.color.temperature + " , againast temperatureRange, temperatureMin:" + hastemperatureMin + ", temperatureMax:" + temperatureMax);
								if (params.color.temperature > temperatureMaxK || params.color.temperature < temperatureMinK){
									// Build valueOutOfRange error response
									validationStatus = false;
									logger.log('warn', "[GHome Exec API] valueOutOfRange error for endpointId:" + element.id);
									// Global error response
									var errResponse = {
										"requestId": req.body.requestId,
										"payload": {
											"errorCode": "valueOutOfRange"
										}
									}
									logger.log('debug', "[GHome Exec API] Color Temperature valueOutOfRange error response:" + JSON.stringify(errResponse));
									res.status(200).json(errResponse);
								}
							}
						}
						// Handle 2FA requirement
						var hasRequire2FA = getSafe(() => data.attributes.require2FA);
						if (hasRequire2FA == true) {
							var hasChallengeType = getSafe(() => data.attributes.type2FA); // check device for 2FA challenge type
							var hasChallengePin = getSafe(() => arrCommands[i].execution[0].challenge.pin); // check request itself for pin
							// PIN Required, NO pin supplied
							if (hasChallengeType == "pin" && hasChallengePin == undefined){
								validationStatus = false;
								logger.log('warn', "[GHome Exec API] pinNeeded but not supplied for command against endpointId:" + element.id);
								var errResponse = {
									requestId: req.body.requestId,
									payload: {
										commands: [{
											ids: [element.id.toString()],
											status: "ERROR",
											errorCode: "challengeNeeded",
											challengeNeeded : {
												type: "pinNeeded"
											}
										}]
									}
								};
								logger.log('debug', "[GHome Exec API] Color Temperature valueOutOfRange error response:" + JSON.stringify(errResponse));
								res.status(200).json(errResponse);
							}
							// PIN required, wrong PIN
							else if (hasChallengeType == "pin" && hasChallengePin != data.attributes.pin){
								validationStatus = false;
								logger.log('warn', "[GHome Exec API] wrong pin supplied for command against endpointId:" + element.id);
								var errResponse = {
									requestId: req.body.requestId,
									payload: {
										commands: [{
											ids: [element.id.toString()],
											status: "ERROR",
											errorCode: "challengeNeeded",
											challengeNeeded : {
												type: "challengeFailedPinNeeded"
											}
										}]
									}
								};
								logger.log('debug', "[GHome Exec API] Color Temperature valueOutOfRange error response:" + JSON.stringify(errResponse));
								res.status(200).json(errResponse);
							}
						}
						///////////////////////////////////////////////////////////////////////////
						// End Validation
						///////////////////////////////////////////////////////////////////////////
						if (validationStatus == true) {
							logger.log('debug', "[GHome Exec API] Command to be executed against endpointId:" + element.id);
							// Set MQTT Topic
							var topic = "command/" + req.user.username + "/" + element.id;
							try{
								// Define MQTT Message
								var message = JSON.stringify({
									requestId: requestId,
									id: element.id,
									execution: arrCommands[i]
								});
								// Publish Command
								mqttClient.publish(topic,message);
								logger.log('verbose', "[GHome Exec API] Published MQTT command for user: " + req.user.username + " topic: " + topic);
								logger.log('debug', "[GHome Exec API] MQTT message:" + message);

							} catch (err) {
								logger.log('warn', "[GHome Exec API] Failed to publish MQTT command for user: " + req.user.username);
								logger.log('debug', "[GHome Exec API] Publish MQTT command error: " + err);
							}
							// Build success response and include in redis-stored command
							var response = {
								requestId: requestId,
								payload: {
									commands: [{
										ids: [element.id],
										status: "SUCCESS",
										state: params
									}]
								}
							}
							var command = {
								user: req.user.username,
								userId: req.user._id,
								requestId: requestId,
								res: res,
								response: response,
								source: "Google",
								devices: [],
								acknowledged: false,
								timestamp: Date.now()
							};

							// Add additional deviceIds to command.devices if multi-device command to enable correlation of responses
							for (x = 0; x < arrCommandsDevices.length; x++) {
								try {
									if (arrCommandsDevices[x].id != element.id){
										//command.response.payload.commands[0].ids.push(arrCommandsDevices[x].id);
										command.devices.push(arrCommandsDevices[x].id);
										logger.log('debug', "[GHome Exec API] Added endpointId to multi-device command");
									}
								}
								catch(e) {
									logger.log('error', "[GHome Exec API] Unable to add endpointId to multi-command response, error: " + e);
								}
							}
							ongoingCommands[requestId + element.id] = command; // Command drops into buffer w/ 6000ms timeout (see defined function above) - ACK comes from N/R flow
							// client.hset(requestId + element.id, 'command', command); // Command drops into redis database, used to generate failure messages if not ack
						}
					});
				}
			}
			catch(e) {
				logger.log('error', "[GHome Exec API] error:" + e.stack)
				res.status(500).json({message: "An error occurred."});
			}
			break;
		///////////////////////////////////////////////////////////////////////////
		// QUERY
		///////////////////////////////////////////////////////////////////////////
		case 'action.devices.QUERY' :
			try {
				logger.log('verbose', "[GHome QUERY API] Running device state query for user: " + req.user.username);
				sendEventUid(req.path, "QUERY", "GHome QUERY Event", req.ip, req.user.username, req.headers['user-agent']);
				// Find associated user for command
				var user = await Account.find({username: req.user.username});
				// Find users devices
				var devices = await Devices.find({username: req.user.username});
				// Build array of devices in-scope of command
				var arrQueryDevices = req.body.inputs[0].payload.devices;
				// Create basic/ template response payload
				var response = {
					"requestId": requestId,
					"payload": {
						"devices" : {}
					}
				}
				// For every device in scope of command find device state and add to response
				await Promise.all(arrQueryDevices.map(async dev => {
					// From existing devices object, confirm matching device exists
					var data = devices.find(obj => obj.endpointId == dev.id);
					// If exists, get state, ion GHome format and add to response payload
					if (data) {
						var state = await queryDeviceStateAsync(data);
						if (state != undefined) {
							response.payload.devices[data.endpointId] = state;
						}
					}
				}))
				// Output response payload to console
				logger.log('verbose', "[GHome QUERY API] QUERY state: " + JSON.stringify(response));
				// Send response payload to GHome
				res.status(200).json(response);
			}
			catch(e) {
				logger.log('error', "[GHome QUERY API] error:" + e.stack)
				res.status(500).json({message: "An error occurred."});
			}
			break;
		///////////////////////////////////////////////////////////////////////////
		// DISCONNECT
		///////////////////////////////////////////////////////////////////////////
		case 'action.devices.DISCONNECT' :
			try {
				var userId = req.user._id;
				sendEventUid(req.path, "DISCONNECT", "GHome DISCONNECT Event", req.ip, req.user.username, req.headers['user-agent']);
				// Find Google Home speciifc Application Id (could vary on other instances)
				var appGHome = await oauthModels.Application.findOne({domains: "oauth-redirect.googleusercontent.com" });
				// Delete user OAuth data for Google Home
				await oauthModels.GrantCode.deleteMany({user: userId, application: appGHome._id});
				await oauthModels.AccessToken.deleteMany({user: userId, application: appGHome._id});
				await oauthModels.RefreshToken.deleteMany({user: userId, application: appGHome._id});
				// Send success
				res.status(200).send();
				// Remove 'Google' from users' active services
				removeUserServices(req.user.username, "Google")
			}
			catch(e) {
				logger.log('error', "[GHome Disconnect API] Failed to delete GrantCodes, RefreshToken and AccessTokens for user account: " + userId + ", error: " + e.stack);
				res.status(500).json({error: err});
			}
			break;
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
