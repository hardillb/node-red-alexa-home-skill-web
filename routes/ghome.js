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
var ua = require('universal-analytics');
var passport = require('passport');
var BasicStrategy = require('passport-http').BasicStrategy;
var LocalStrategy = require('passport-local').Strategy;
var PassportOAuthBearer = require('passport-http-bearer');
var mqtt = require('mqtt');
var logger = require('../config/logger');
const gHomeFunc = require('../functions/func-ghome');
const servicesFunc = require('../functions/func-services');
var client = require('../config/redis')
///////////////////////////////////////////////////////////////////////////
// Functions
///////////////////////////////////////////////////////////////////////////
const queryDeviceState = gHomeFunc.queryDeviceState;
const updateUserServices = servicesFunc.updateUserServices;
const removeUserServices = servicesFunc.removeUserServices;
///////////////////////////////////////////////////////////////////////////
// Variables
///////////////////////////////////////////////////////////////////////////
var debug = (process.env.ALEXA_DEBUG || false);
// MQTT ENV variables========================
var mqtt_user = (process.env.MQTT_USER);
var mqtt_password = (process.env.MQTT_PASSWORD);
var mqtt_port = (process.env.MQTT_PORT || "1883");
var mqtt_url = (process.env.MQTT_URL || "mqtt://mosquitto:" + mqtt_port);
// Google Analytics ==========================
var enableAnalytics = false;
if (process.env.GOOGLE_ANALYTICS_TID != undefined) {
    enableAnalytics = true;
    var visitor = ua(process.env.GOOGLE_ANALYTICS_TID);
}
///////////////////////////////////////////////////////////////////////////
// Passport Configuration
///////////////////////////////////////////////////////////////////////////
passport.use(new LocalStrategy(Account.authenticate()));
passport.use(new BasicStrategy(Account.authenticate()));
passport.serializeUser(Account.serializeUser());
passport.deserializeUser(Account.deserializeUser());
var accessTokenStrategy = new PassportOAuthBearer(function(token, done) {
	oauthModels.AccessToken.findOne({ token: token }).populate('user').populate('grant').exec(function(error, token) {
		if (!error && token && !token.grant) {
			logger.log('error', "[Core] Missing grant token:" + token);
		}
		if (!error && token && token.active && token.grant && token.grant.active && token.user) {
			logger.log('debug', "[Core] OAuth Token good, token:" + token);
			done(null, token.user, { scope: token.scope });
		} else if (!error) {
			logger.log('error', "[Core] OAuth Token error, token:" + token);
			done(null, false);
		} else {
			logger.log('error', "[Core] OAuth Token error:" + error);
			done(error);
		}
	});
});
passport.use(accessTokenStrategy);
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
	clientId: 'gHomeAPI_' + Math.random().toString(16).substr(2, 8)
};
if (mqtt_user) {
	mqttOptions.username = mqtt_user;
	mqttOptions.password = mqtt_password;
}
logger.log('info', "[GHome API] Connecting to MQTT server: " + mqtt_url);
mqttClient = mqtt.connect(mqtt_url, mqttOptions);
mqttClient.on('error',function(err){
	logger.log('error', "[GHome API] MQTT connect error");
});
mqttClient.on('reconnect', function(){
	logger.log('warn', "[GHome API] MQTT reconnect event");
});
mqttClient.on('connect', function(){
	logger.log('info', "[GHome API] MQTT connected, subscribing to 'response/#'")
	mqttClient.subscribe('response/#');
});
///////////////////////////////////////////////////////////////////////////
// Rate-limiter 
///////////////////////////////////////////////////////////////////////////
const limiter = require('express-limiter')(router, client)
// Default Limiter, used on majority of routers ex. OAuth2-related and Command API
const defaultLimiter = limiter({
	lookup: function(req, res, opts, next) {
		//opts.lookup = 'connection.remoteAddress'
		opts.lookup = 'headers.x-forwarded-for'
		opts.total = 100
		opts.expire = 1000 * 60 * 60
		return next()
  },
	onRateLimited: function (req, res, next) {
		logger.log('warn', "[Rate Limiter] Default rate-limit exceeded for path: " + req.path + ", IP address:" + req.ip)
		var params = {
			ec: "Express-limiter",
			ea: "Default: rate-limited path: " + req.path + ", IP address:" + req.ip,
			uip: req.ip
		  }
		if (enableAnalytics) {visitor.event(params).send()};
		res.status(429).json('Rate limit exceeded');
	  }
});
///////////////////////////////////////////////////////////////////////////
// Main GHome Action API
///////////////////////////////////////////////////////////////////////////
// Removed basic auth, original line: passport.authenticate(['bearer', 'basic'], { session: false }),
router.post('/action', defaultLimiter,
	passport.authenticate('bearer', { session: false }),
	function(req,res,next){
	logger.log('verbose', "[GHome API] Request:" + JSON.stringify(req.body));
	var intent = req.body.inputs[0].intent;
	var requestId = req.body.requestId;
	var serviceName = "Google"; // As user has authenticated, assume activeService
	if (!req.user.activeServices || (req.user.activeServices && req.user.activeServices.indexOf(serviceName)) == -1) {updateUserServices(req.user.username, serviceName)};
	
	switch (intent) {
		///////////////////////////////////////////////////////////////////////////
		// SYNC
		///////////////////////////////////////////////////////////////////////////
		case 'action.devices.SYNC' :
			logger.log('verbose', "[GHome Sync API] Running device discovery for user: " + req.user.username);
			var params = {
				ec: "SYNC",
				ea: "GHome SYNC event for username: " + req.user.username,
				uid: req.user.username,
				uip: req.ip,
				dp: "/api/v1/action"
			  }
			if (enableAnalytics) {visitor.event(params).send()};

			//if (debug == "true") {console.time('ghome-sync')};
			var pFindUser = Account.find({username: req.user.username});
			var pFindDevices = Devices.find({username: req.user.username});
			Promise.all([pFindUser, pFindDevices]).then(([user, devices]) => {
				if (user && devices) {
					logger.log('debug', "[GHome Sync API] User: " + JSON.stringify(user[0]));
					logger.log('debug', "[GHome Sync API] Devices: " + JSON.stringify(devices));
					// Build Device Array
					var devs = [];
					for (var i=0; i< devices.length; i++) {
						var deviceJSON = JSON.parse(JSON.stringify(devices[i])); 
						//logger.log('debug','[GHome Sync API] Building device data for device:' + JSON.stringify(devices[i]))
						var dev = {}
						dev.id = "" + devices[i].endpointId;
						dev.type = gHomeReplaceType(devices[i].displayCategories);
						dev.traits = [];
						// Check supported device type
						if (dev.type != "NA") {
							// Check supported capability/ trait
							devices[i].capabilities.forEach(function(capability){
								var trait = gHomeReplaceCapability(capability, dev.type);
								// Add supported traits, don't add duplicates
								if (trait != "Not Supported" && dev.traits.indexOf(trait) == -1){
									dev.traits.push(trait);
								}
							});
						}
						dev.name = {
							name : devices[i].friendlyName
							}
						dev.willReportState = devices[i].reportState;
						
						var hasAttributes = 'attributes' in deviceJSON;
						if (hasAttributes == true) {
							dev.attributes = devices[i].attributes;
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
						if (devices[i].capabilities.indexOf("ColorController") > -1 ){
							dev.attributes.colorModel = "hsv";
							delete dev.attributes.commandOnlyColorSetting; // defaults to false anyway
						}
						// Pass min/ max values as float
						if (devices[i].capabilities.indexOf("ColorTemperatureController") > -1 ){
							dev.attributes.colorTemperatureRange.temperatureMinK = parseInt(dev.attributes.colorTemperatureRange.temperatureMinK);
							dev.attributes.colorTemperatureRange.temperatureMaxK = parseInt(dev.attributes.colorTemperatureRange.temperatureMaxK);
						}
						// FanSpeed, map 1:1 with RangeController 1-10
						if (devices[i].capabilities.indexOf("RangeController") > -1 && (dev.type.indexOf('action.devices.types.FAN') > -1 || dev.type.indexOf('action.devices.types.THERMOSTAT') > -1 )){
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
					//if (debug == "true") {console.timeEnd('ghome-sync')};
				}
				else if (!user){
					logger.log('warn', "[GHome Sync API] User not found");
					res.status(500).json({message: "User not found"});
					//if (debug == "true") {console.timeEnd('ghome-sync')};
				}
				else if (!device) {
					logger.log('warn', "[GHome Sync API] Device not found");
					res.status(500).json({message: "Device not found"});
					//if (debug == "true") {console.timeEnd('ghome-sync')};
				}
			}).catch(err => {
				logger.log('error', "[GHome Sync API] error:" + err)
				res.status(500).json({message: "An error occurred."});
				//if (debug == "true") {console.timeEnd('ghome-sync')};
			});
			break;

		///////////////////////////////////////////////////////////////////////////
		// EXECUTE
		///////////////////////////////////////////////////////////////////////////
		case 'action.devices.EXECUTE' : 
			logger.log('verbose', "[GHome Exec API] Execute command(s) for user: " + req.user.username);
			var params = {
				ec: "EXECUTE",
				ea: "GHome EXECUTE event for username: " + req.user.username,
				uid: req.user.username,
				uip: req.ip,
				dp: "/api/v1/action"
			  }
			if (enableAnalytics) {visitor.event(params).send()};

			//if (debug == "true") {console.time('ghome-exec')};
			var pFindDevices = Devices.find({username: req.user.username});
			Promise.all([pFindDevices]).then(([devices]) => {
				if (devices) {
					logger.log('debug', "[GHome Exec API] Execute command(s) for user: " + req.user.username + ", command: " +  JSON.stringify(req.body.inputs[0].payload.commands));
					var arrCommands = req.body.inputs[0].payload.commands; // Array of commands, assume match with device array at same index?!
					//logger.log('debug', "[GHome Exec API] Returned mongodb devices typeof:" + typeof devices);
					//var devicesJSON = JSON.parse(JSON.stringify(devices));
					//logger.log('debug', "[GHome Exec API] User devices:" + JSON.stringify(devicesJSON));

					for (var i=0; i< arrCommands.length; i++) { // Iterate through commands in payload, against each listed 
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
									mqttClient.publish(topic,message); // Publish Command
									logger.log('verbose', "[GHome Exec API] Published MQTT command for user: " + req.user.username + " topic: " + topic);
									logger.log('debug', "[GHome Exec API] MQTT message:" + message);

								} catch (err) {
									logger.log('warn', "[GHome Exec API] Failed to publish MQTT command for user: " + req.user.username);
									logger.log('debug', "[GHome Exec API] Publish MQTT command error: " + err);
								}
								// Build success response and include in onGoingCommands
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
								onGoingCommands[requestId + element.id] = command; // Command drops into buffer w/ 6000ms timeout (see defined function above) - ACK comes from N/R flow
							}
						});
					}
					//if (debug == "true") {console.timeEnd('ghome-exec')};
				}
				else if (!device) {
					logger.log('warn', "[GHome Exec API] Device not found");
					res.status(500).json({message: "Device not found"});
					//if (debug == "true") {console.timeEnd('ghome-exec')};
				}
			}).catch(err => {
				logger.log('error', "[GHome Exec API] error:" + err)
				res.status(500).json({message: "An error occurred."});
				//if (debug == "true") {console.timeEnd('ghome-exec')};
			});
			break;
		///////////////////////////////////////////////////////////////////////////
		// QUERY
		///////////////////////////////////////////////////////////////////////////
		case 'action.devices.QUERY' :
			logger.log('verbose', "[GHome Query API] Running device state query for user: " + req.user.username);

			var params = {
				ec: "QUERY",
				ea: "GHome QUERY event for username: " + req.user.username,
				uid: req.user.username,
				uip: req.ip,
				dp: "/api/v1/action"
			  }
			if (enableAnalytics) {visitor.event(params).send()};

			//if (debug == "true") {console.time('ghome-query')};
			var pFindUser = Account.find({username: req.user.username});
			var pFindDevices = Devices.find({username: req.user.username});
			Promise.all([pFindUser, pFindDevices]).then(([user, devices]) => {
				if (user && devices) {
					var arrQueryDevices = req.body.inputs[0].payload.devices;
					var response = {
						"requestId": requestId,
						"payload": {
							"devices" : {}
						}
					}
					const start = async () => {
						await Promise.all(arrQueryDevices.map(async dev => {
							var data = devices.find(obj => obj.endpointId == dev.id);
							if (data) {
								await queryDeviceState(data, function(state) {
									if (response != undefined) {
										response.payload.devices[data.endpointId] = state;
									}
								});
							}
							else {
								logger.log('warn', "[GHome Query API] Unable to match a requested device with user endpointId");
							}
						}))
						// Send Response
						logger.log('verbose', "[GHome Query API] QUERY state: " + JSON.stringify(response));
						res.status(200).json(response);
						//if (debug == "true") {console.timeEnd('ghome-query')};
					}
					start()
				}
				else if (!user){
					logger.log('warn', "[GHome Query API] User not found");
					res.status(500).json({message: "User not found"});
					//if (debug == "true") {console.timeEnd('ghome-query')};
				}
				else if (!device) {
					logger.log('warn', "[GHome Query API] Device not found");
					res.status(500).json({message: "Device not found"});
					//if (debug == "true") {console.timeEnd('ghome-query')};
				}

			}).catch(err => {
				logger.log('error', "[GHome Query API] error:" + err)
				res.status(500).json({message: "An error occurred."});
				//if (debug == "true") {console.timeEnd('ghome-query')};
			});
			break;
		///////////////////////////////////////////////////////////////////////////
		// DISCONNECT
		///////////////////////////////////////////////////////////////////////////
		case 'action.devices.DISCONNECT' : 
			// Find service definition with Google URLs
			var userId = req.user._id;
			var params = {
				ec: "DISCONNECT",
				ea: "GHome Disconnect event for username: " + req.user.username,
				uid: req.user.username,
				uip: req.ip,
				dp: "/api/v1/action"
			  }
			if (enableAnalytics) {visitor.event(params).send()};

			oauthModels.Application.findOne({domains: "oauth-redirect.googleusercontent.com" },function(err, data){
				if (data) {
					// Remove OAuth tokens for **Google Home** only
					logger.log('debug', "[GHome Disconnect API] Disconnect request for userId:" + userId + ", application:" + data.title);
					var pGrantCodes = oauthModels.GrantCode.deleteMany({user: userId, application: data._id});
					var pAccessTokens = oauthModels.AccessToken.deleteMany({user: userId, application: data._id});
					var pRefreshTokens = oauthModels.RefreshToken.deleteMany({user: userId, application: data._id});
					Promise.all([pGrantCodes, pAccessTokens, pRefreshTokens]).then(result => {
						logger.log('info', "[GHome Disconnect API] Deleted GrantCodes, RefreshToken and AccessTokens for user account: " + userId)
						res.status(200).send();
						removeUserServices(req.user.username, "Google")
					}).catch(err => {
					 	logger.log('warn', "[GHome Disconnect API] Failed to delete GrantCodes, RefreshToken and AccessTokens for user account: " + userId);
					 	res.status(500).json({error: err});
					});
				}
			});
			break; 
	}
});
///////////////////////////////////////////////////////////////////////////
// MQTT Message Event Handlers
///////////////////////////////////////////////////////////////////////////
var onGoingCommands = {};
// Event handler for received MQTT messages - note subscribe near top of script.
mqttClient.on('message',function(topic,message){
	var arrTopic = topic.split("/"); 
	var username = arrTopic[1];
	var endpointId = arrTopic[2];
	if (topic.startsWith('response/')){
		logger.log('info', "[GHome API] Acknowledged MQTT response message for topic: " + topic);
		var payload = JSON.parse(message.toString());
		//logger.log('debug', "[GHome API] Response MQTT message for user: " + username + ", message: " + message);
		var commandWaiting = onGoingCommands[payload.messageId + endpointId];
		if (commandWaiting) {
			//if (commandWaiting.hasOwnProperty('source')){logger.log('debug', "[GHome API] Found matching command for user: " + username + ", command.source: " + JSON.stringify(commandWaiting.source));};
			//console.log("mqtt response: " + JSON.stringify(payload,null," "));
			if (payload.success) {
				//logger.log('debug', "[GHome API] MQTT response message is success for topic: " + topic);
				// Google Home success response
				if (commandWaiting.hasOwnProperty('source')){
					var commandSource = JSON.stringify(commandWaiting.source);
					commandSource = commandSource.replace(/['"]+/g, '');
					if (commandSource == "Google") {
						// Check if command had >1 target device, if so we need to ensure all commands are successful
						var arrCommandDevices =  commandWaiting.devices;
						///////////////////////////////////////////////////////////////////////////
						// Multi-device command, perform correlation of responses
						///////////////////////////////////////////////////////////////////////////
						if (Array.isArray(arrCommandDevices) && arrCommandDevices.length !== 0 ){
							logger.log('debug', "[GHome API] Google Home multi-device command response for user: " + username +  ", ***existing*** response: " + JSON.stringify(commandWaiting.response));
							logger.log('debug', "[GHome API] Google Home multi-device command response for user: " + username +  ", additional devices: " + JSON.stringify(commandWaiting.devices));

							// Mark this command as acknowledged/ successful as we have a response for it
							commandWaiting.acknowledged = true;
							// Add endpointId to response (if it isn't already there)
							if (commandWaiting.response.payload.commands[0].ids.indexOf(endpointId) == -1){commandWaiting.response.payload.commands[0].ids.push(endpointId)};
							// Check for other commands, and that all are acknowledged
							var sendResponse = true;
							for (x = 0; x < arrCommandDevices.length; x++) {
								var additionalCommand = onGoingCommands[payload.messageId + arrCommandDevices[x]];

								/// Temporary
								if (additionalCommand){
									logger.log('debug', "[GHome API] Found Additional Command")
									if (additionalCommand.acknowledged){logger.log('debug', "[GHome API] Found Additional Command acknowledged element")}
									if (additionalCommand.acknowledged == true){logger.log('debug', "[GHome API] Additional Command acknowledged element TRUE")}
								}
								else {logger.log('debug', "[GHome API] Did Not Find Additional Command")}
								///

								// Check that endpointId hasn't already been added to response
								if (additionalCommand && additionalCommand.acknowledged && additionalCommand.acknowledged == true && commandWaiting.response.payload.commands[0].ids.indexOf(arrCommandDevices[x]) == -1){
									// Add successful command endpointId to response and delete the additionalCommand that is waiting
									// Essentially we should get down to a single acknowledged waiting command with deviceIds in response that have successfully executed the command 
									if (additionalCommand.acknowledged == true) {
										commandWaiting.response.payload.commands[0].ids.push(arrCommandDevices[x]);
										delete onGoingCommands[additionalCommand.requestId + arrCommandDevices[x]];
										logger.log('debug', "[GHome API] Merged *acknowledged* multi-device command response: " + username +  ", ***updated*** response: " + JSON.stringify(commandWaiting.response));
									}
									// This additional command is yet to be acknowledged via MQTT response from Node-RED
									else {
										logger.log('debug', "[GHome API] Google Home multi-device command *not* acknowledged: " + username +  ", ***un-modified*** response: " + JSON.stringify(commandWaiting.response));
										sendResponse = false;
									}
								}
							}
							// All commands in multi-device command have been executed successfully
							if (sendResponse == true) {
								logger.log('debug', "[GHome API] Successful Google Home multi-device command for user: " + username +  ", response: " + JSON.stringify(commandWaiting.response));
								try {
									// Multi-devices this generates an error as res is sent after first device
									commandWaiting.res.status(200).json(commandWaiting.response);
									delete onGoingCommands[payload.messageId + endpointId];

									var params = {
										ec: "Command",
										ea: "Command API successfully processed MQTT command for username: " + username,
										uid: username,
									  }
									if (enableAnalytics) {visitor.event(params).send()};
								}
								catch(e) {
									logger.log('warn', "[GHome API] Warning: " + e);
								}
							}

						}
						///////////////////////////////////////////////////////////////////////////
						// Single-device command
						///////////////////////////////////////////////////////////////////////////
						else {
							try {
								commandWaiting.res.status(200).json(commandWaiting.response);
								logger.log('debug', "[GHome API] Successful Google Home MQTT command for user: " + username +  ", response: " + JSON.stringify(commandWaiting.response));
								delete onGoingCommands[payload.messageId + endpointId];

								var params = {
									ec: "Command",
									ea: "Command API successfully processed MQTT command for username: " + username,
									uid: username,
								  }
								if (enableAnalytics) {visitor.event(params).send()};
							}
							catch(e) {
								logger.log('warn', "[GHome API] Warning: " + e);
							}
						}
					}
				}
	
			} else {
				logger.log('debug', "[GHome API] MQTT response message is failure for topic: " + topic);
				// Google Home failure response
				if (commandWaiting.hasOwnProperty('source')) {
					var commandSource = JSON.stringify(commandWaiting.source);
					commandSource = commandSource.replace(/['"]+/g, '');
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
						delete onGoingCommands[payload.messageId + endpointId];
					}
				}
			}
			//delete onGoingCommands[payload.messageId + endpointId];
		}
		//if (debug == "true") {console.timeEnd('mqtt-response')};
	}
	// Leave Alexa API MQTT state listener to pickup all other MQTT state messages
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
			if (diff > 2000) {
				logger.log('warn', "[MQTT] MQTT command timed out/ unacknowledged: " + keys[key]);

				var arrCommandDevices =  waiting.devices;
				///////////////////////////////////////////////////////////////////////////
				// Multi-device command, perform correlation of responses
				///////////////////////////////////////////////////////////////////////////
				// Check for other commands, should only find one as we've cleaned up further up
				var sendResponse = true;
				var response = undefined;
				if (Array.isArray(arrCommandDevices) && arrCommandDevices.length !== 0 ){ 
					logger.log('debug', "[GHome API] Multi-device command waiting");
					for (x = 0; x < arrCommandDevices.length; x++) {
						var additionalCommand = onGoingCommands[waiting.requestId + arrCommandDevices[x]];
						if (additionalCommand && additionalCommand.acknowledged && additionalCommand.acknowledged == true) {
							logger.log('debug', "[GHome API] Found command waiting, multi-device command acknowledged!");
							response = additionalCommand.response;
							delete onGoingCommands[additionalCommand.requestId + arrCommandDevices[x]];
						}
						// Additional command yet to be acknowledged/ i.e. not successful
						else {
							logger.log('debug', "[GHome API] Found command waiting, but multi-device command *not* acknowledged!");
							sendResponse = false;
						}
					}
					// All commands in multi-device command have been executed successfully
					if (sendResponse == true && response !== undefined) {
						logger.log('debug', "[GHome API] Successful Google Home multi-device command for user: " + username +  ", response: " + JSON.stringify(waiting.response));
						try {
							// Multi-devices this generates an error as res is sent after first device
							waiting.res.status(200).json(response);
							delete onGoingCommands[keys[key]];

						}
						catch(e) {
							logger.log('warn', "[GHome API] Warning: " + e);
							delete onGoingCommands[keys[key]];
						}
					}
					// No acknowledged commands, so send timeout
					else {
						logger.log('debug', "[GHome API] Google Home multi-device command timed-out");
						try {
							waiting.res.status(504).send('{"error": "timeout"}');
							delete onGoingCommands[keys[key]];
						}
						catch(e) {
							logger.log('debug', "[GHome API] Google Home multi-device command timed-out, unable to send result, error: " + e);
							delete onGoingCommands[keys[key]];
						}
					}
				}
				///////////////////////////////////////////////////////////////////////////
				// Single device command, perform correlation of responses
				///////////////////////////////////////////////////////////////////////////
				else {
					try {
						waiting.res.status(504).send('{"error": "timeout"}');
						logger.log('debug', "[GHome API] Google Home command timed-out");
						delete onGoingCommands[keys[key]];
					}
					catch(e) {
						logger.log('debug', "[GHome API] Google Home single-device command timed-out, unable to send result, error: " + e);
						delete onGoingCommands[keys[key]];
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
	}
},500);
///////////////////////////////////////////////////////////////////////////
// Functions
///////////////////////////////////////////////////////////////////////////
// Convert Alexa Device Capabilities to Google Home-compatible
function gHomeReplaceCapability(capability, type) {
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
function gHomeReplaceType(type) {
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

module.exports = router;
