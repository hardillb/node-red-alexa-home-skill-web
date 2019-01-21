// Express Router ============================
var express = require('express');
var router = express.Router();
var bodyParser = require('body-parser');
router.use(bodyParser.urlencoded({ extended: true }));
router.use(bodyParser.json());
// ===========================================
// Schema =======================
var Account = require('../models/account');
var oauthModels = require('../models/oauth');
var Devices = require('../models/devices');
var Topics = require('../models/topics');
var LostPassword = require('../models/lostPassword');
// ===============================
// Auth Handler ==============================
var passport = require('passport');
var BasicStrategy = require('passport-http').BasicStrategy;
var LocalStrategy = require('passport-local').Strategy;
var countries = require('countries-api');
var PassportOAuthBearer = require('passport-http-bearer');
var oauthServer = require('../oauth');
var url = require('url');
// ===========================================
// Winston Logger ============================
var logger = require('../config/logger');
var debug = (process.env.ALEXA_DEBUG || false);
// ===========================================
// Google Auth JSON Web Token ================
const jwt = require('jsonwebtoken');
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
// ===========================================
// Google Analytics ==========================
var ua = require('universal-analytics');
var enableAnalytics = false;
if (process.env.GOOGLE_ANALYTICS_TID != undefined) {
    enableAnalytics = true;
    var visitor = ua(process.env.GOOGLE_ANALYTICS_TID);
}
//===========================================
// Passport Config, Local *and* Oauth Support =
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
//===========================================
// MQTT =====================================
var mqtt = require('mqtt');
//===========================================
// MQTT ENV variables========================
var mqtt_user = (process.env.MQTT_USER);
var mqtt_password = (process.env.MQTT_PASSWORD);
var mqtt_port = (process.env.MQTT_PORT || "1883");
var mqtt_url = (process.env.MQTT_URL || "mqtt://mosquitto:" + mqtt_port);
//===========================================
// MQTT Config ==============================
var mqttClient;
var mqttOptions = {
	connectTimeout: 30 * 1000,
	reconnectPeriod: 1000,
	keepAlive: 10,
	clean: true,
	resubscribe: true,
	clientId: 'alexaAPI_' + Math.random().toString(16).substr(2, 8)
};
if (mqtt_user) {
	mqttOptions.username = mqtt_user;
	mqttOptions.password = mqtt_password;
}
logger.log('info', "[Alexa API] Connecting to MQTT server: " + mqtt_url);
mqttClient = mqtt.connect(mqtt_url, mqttOptions);
mqttClient.on('error',function(err){
	logger.log('error', "[Alexa API] MQTT connect error");
});
mqttClient.on('reconnect', function(){
	logger.log('warn', "[Alexa API] MQTT reconnect event");
});
mqttClient.on('connect', function(){
	logger.log('info', "[Alexa API] MQTT connected, subscribing to 'response/#'")
	mqttClient.subscribe('response/#');
	logger.log('info', "[Alexa API] MQTT connected, subscribing to 'state/#'")
	mqttClient.subscribe('state/#');
});
// Redis Client =============================
var client = require('../config/redis')
// ==========================================
// Rate-limiter =============================
const limiter = require('express-limiter')(router, client)
// Default Limiter, used on majority of routers ex. OAuth2-related and Command API
const defaultLimiter = limiter({
	lookup: function(req, res, opts, next) {
		opts.lookup = 'connection.remoteAddress'
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
// GetState Limiter, uses specific param, 100 reqs/ hr
const getStateLimiter = limiter({
	lookup: function(req, res, opts, next) {
		  opts.lookup = ['params.dev_id']
		  opts.total = 100
		  opts.expire = 1000 * 60 * 60
		  return next()
	},
	onRateLimited: function (req, res, next) {
		if (req.hasOwnProperty('user')) {
			logger.log('warn', "Rate limit exceeded for user:" + req.user.username)
			var params = {
				ec: "Express-limiter",
				ea: "Rate limited: " + req.user.username,
				uid: req.user.username,
				uip: req.ip
			  }
			if (enableAnalytics) {visitor.event(params).send()};
		}
		else {
			logger.log('warn', "[Rate Limiter] GetState rate-limit exceeded for IP address:" + req.ip)
			var params = {
				ec: "Express-limiter",
				ea: "GetState: rate-limited path: " + req.path + ", IP address:" + req.ip,
				uip: req.ip
			  }
			if (enableAnalytics) {visitor.event(params).send()};
		}
		res.status(429).json('Rate limit exceeded for GetState API');
	  }
  });
// ==========================================

///////////////////////////////////////////////////////////////////////////
// Discovery API, can be tested via credentials of an account/ browsing to http://<hostname>/api/v1/devices
///////////////////////////////////////////////////////////////////////////
router.get('/devices', defaultLimiter,
	passport.authenticate(['bearer', 'basic'], { session: false }),
	function(req,res,next){
		var params = {
			ec: "Discovery",
			ea: "Running device discovery for username: " + req.user.username,
			uid: req.user.username,
			uip: req.ip,
			dp: "/api/v1/devices"
		  }
		if (enableAnalytics) {visitor.event(params).send()};

		var user = req.user.username
		Devices.find({username: user},function(error, data){
			if (!error) {
				logger.log('info', "[Discover API] Running device discovery for user:" + user);
				var devs = [];
				for (var i=0; i< data.length; i++) {
					var dev = {};
					dev.friendlyName = data[i].friendlyName;
					dev.description = data[i].description;
					dev.endpointId = "" + data[i].endpointId;
					dev.reportState = data[i].reportState;
					// Handle multiple capabilities, call replaceCapability to replace placeholder capabilities
					dev.capabilities = [];
					// Grab device attributes for use in building discovery response
					var devAttribues = (data[i].attributes || null);
					data[i].capabilities.forEach(function(capability){
						dev.capabilities.push(replaceCapability(capability, dev.reportState, devAttribues))
					});
					dev.displayCategories = data[i].displayCategories;
					dev.cookie = data[i].cookie;
					dev.version = "0.0.3";
					dev.manufacturerName = "Node-RED"
					devs.push(dev);
				}
				//console.log(devs)
				res.send(devs);
			}	
		});
	}
);

// Replace Capability function, replaces 'placeholders' stored under device.capabilities in mongoDB with Amazon JSON
function replaceCapability(capability, reportState, attributes) {
	// BrightnessController
	if(capability == "BrightnessController")  {
		return {
				"type": "AlexaInterface",
				"interface": "Alexa.BrightnessController",
				"version": "3",
				"properties": {
					"supported": [{
						"name": "brightness"
					}],
					"proactivelyReported": false,
					"retrievable": reportState
				}
			};
	}
	// ChannelController
	if(capability == "ChannelController") {
		return {
			"type": "AlexaInterface",
			"interface": "Alexa.ChannelController",
			"version": "3",
			};
	}
	// ColorController
	if(capability == "ColorController")  {
		return {
				"type": "AlexaInterface",
				"interface": "Alexa.ColorController",
				"version": "3",
				"properties": {
					"supported": [{
						"name": "color"
					}],
					"proactivelyReported": false,
					"retrievable": reportState
				}
			};
	}
	// ColorTemperatureController
	if(capability == "ColorTemperatureController")  {
		return {
				"type": "AlexaInterface",
				"interface": "Alexa.ColorTemperatureController",
				"version": "3",
				"properties": {
					"supported": [{
						"name": "colorTemperatureInKelvin"
					}],
					"proactivelyReported": false,
					"retrievable": reportState
				}
			};
	}
	// InputController, pre-defined 4x HDMI inputs and phono
	if(capability == "InputController") {
		return {
			"type": "AlexaInterface",
			"interface": "Alexa.InputController",
			"version": "3",
			"inputs": [{
				"name": "HDMI1"
			  },
			  {
				"name": "HDMI2"
			  },
			  {
				"name": "HDMI3"
			  },
			  {
				"name": "HDMI4"
			  },
			  {
				"name": "phono"
			  },
			  {
				"name": "audio1"
			  },
			  {
				"name": "audio2"
			  },
			  {
				"name": "chromecast"
			  }
			]};
	}
	// LockController
	if(capability == "LockController")  {
		return {
				"type": "AlexaInterface",
				"interface": "Alexa.LockController",
				"version": "3",
				"properties": {
					"supported": [{
						"name": "lockState"
					}],
					"proactivelyReported": false,
					"retrievable": reportState
				}
			};
	}
	// PercentageController
	if(capability == "PercentageController") {
		return {
			"type": "AlexaInterface",
			"interface": "Alexa.PercentageController",
			"version": "3",
			"properties": {
				"supported": [{
					"name": "percentage"
				}],
				"proactivelyReported": false,
				"retrievable": reportState
			}
		};
	}
	// PlaybackController
	if(capability == "PlaybackController") {
		return {
			"type": "AlexaInterface",
			"interface": "Alexa.PlaybackController",
			"version": "3",
			"supportedOperations" : ["Play", "Pause", "Stop", "FastForward", "StartOver", "Previous", "Rewind", "Next"]
			};
	}
	// PowerController
	if(capability == "PowerController") {
		return {
			"type": "AlexaInterface",
			"interface": "Alexa.PowerController",
			"version": "3",
			"properties": {
				"supported": [{
					"name": "powerState"
				}],
				"proactivelyReported": false,
				"retrievable": reportState
				}
			};
	}
	// Speaker
	if(capability == "Speaker") {
		return {
			"type": "AlexaInterface",
			"interface": "Alexa.Speaker",
			"version": "3",
			"properties":{
				"supported":[{
						"name":"volume"
					},
					{
						"name":"muted"
					}
				]}
			};
	}
	// SceneController 
	if(capability == "SceneController") {
		return {
			"type": "AlexaInterface",
			"interface": "Alexa.SceneController",
			"version" : "3",
			"supportsDeactivation" : false
			};
	}
	// StepSpeaker
	if(capability == "StepSpeaker") {
		return {
			"type": "AlexaInterface",
			"interface": "Alexa.StepSpeaker",
			"version": "3",
			"properties":{
				"supported":[{
					  "name":"volume"
				   },
				   {
					  "name":"muted"
				   }
				]}
			};
	}
	// TemperatureSensor 
	if(capability == "TemperatureSensor") {
		return {
			"type": "AlexaInterface",
			"interface": "Alexa.TemperatureSensor",
			"version" : "3",
			"properties": {
                "supported": [
                  {
                    "name": "temperature"
                  }
                ],
                "proactivelyReported": false,
                "retrievable": true
              }
			};
	}
	// ThermostatController - SinglePoint
	if(capability == "ThermostatController")  {
		var supportedModes;
		var hasModes = getSafe(() => attributes.thermostatModes);
		if (attributes != null && hasModes != undefined) {
			supportedModes = attributes.thermostatModes;
		}
		else {
			supportedModes = ["HEAT","COOL","AUTO"];
		}
		return {
			"type": "AlexaInterface",
            "interface": "Alexa.ThermostatController",
            "version": "3",
            "properties": {
              "supported": [{
                  "name": "targetSetpoint"
                },
                {
                  "name": "thermostatMode"
                }
              ],
			  "proactivelyReported": false,
			  "retrievable": reportState
            },
            "configuration": {
              "supportsScheduling": true,
              "supportedModes": supportedModes
			}
		};
	}
};

///////////////////////////////////////////////////////////////////////////
// Get State API
///////////////////////////////////////////////////////////////////////////
router.get('/getstate/:dev_id', getStateLimiter,
	passport.authenticate(['bearer', 'basic'], { session: false }),
	function(req,res,next){
		var id = req.params.dev_id;

		var params = {
			ec: "Get State",
			ea: "GetState API request for username: " + req.user.username + ", endpointId: " + id,
			uid: req.user.username,
			uip: req.ip,
			dp: "/api/v1/getstate"
		  }
		if (enableAnalytics) {visitor.event(params).send()};

		// Identify device, we know who user is from request
		logger.log('debug', "[State API] Received GetState API request for user:" + req.user.username + " endpointId:" + id);

		Devices.findOne({username:req.user.username, endpointId:id}, function(err, data){
			if (err) {
				logger.log('warn',"[State API] No device found for username: " + req.user.username + " endpointId:" + id);
				res.status(500).send();
			}
			if (data) {
				var deviceJSON = JSON.parse(JSON.stringify(data)); // Convert "model" object class to JSON object so that properties are query-able
				if (deviceJSON && deviceJSON.hasOwnProperty('reportState')) {
					if (deviceJSON.reportState = true) { // Only respond if device element 'reportState' is set to true
						if (deviceJSON.hasOwnProperty('state')) {
								// Inspect state element and build response based upon device type /state contents
								// Will need to group multiple states into correct update format
								var properties = [];
								
								deviceJSON.capabilities.forEach(function(capability) {
									switch (capability)  {
										case "BrightnessController":
											// Return brightness percentage
											if (deviceJSON.state.hasOwnProperty('brightness') && deviceJSON.state.hasOwnProperty('time')) {
												properties.push({
														"namespace": "Alexa.BrightnessController",
														"name": "brightness",
														"value": deviceJSON.state.brightness,
														"timeOfSample": deviceJSON.state.time,
														"uncertaintyInMilliseconds": 10000
													});
											}
											break;
										case "ChannelController":
											// Return Channel State - no reportable state as of December 2018
											break;
										case "ColorController":
											// Return color
											if (deviceJSON.state.hasOwnProperty('colorHue') && deviceJSON.state.hasOwnProperty('colorSaturation') && deviceJSON.state.hasOwnProperty('colorBrightness') && deviceJSON.state.hasOwnProperty('time')) {
												properties.push({
														"namespace": "Alexa.ColorController",
														"name": "color",
														"value": {
															"hue": deviceJSON.state.colorHue,
															"saturation": deviceJSON.state.colorSaturation,
															"brightness": deviceJSON.state.colorBrightness
														},
														"timeOfSample": deviceJSON.state.time,
														"uncertaintyInMilliseconds": 10000
														});
												}
											break;
										case "ColorTemperatureController":
											// Return color temperature
											if (deviceJSON.state.hasOwnProperty('colorTemperature') && deviceJSON.state.hasOwnProperty('time')) {
												properties.push({
														"namespace": "Alexa.ColorTemperatureController",
														"name": "colorTemperatureInKelvin",
														"value": deviceJSON.state.colorTemperature,
														"timeOfSample": deviceJSON.state.time,
														"uncertaintyInMilliseconds": 10000
													});
											}
											break;
										case "InputController":
											// Return Input
											if (deviceJSON.state.hasOwnProperty('input') && deviceJSON.state.hasOwnProperty('time')) {
												properties.push({
														"namespace": "Alexa.InputController",
														"name": "input",
														"value": deviceJSON.state.input,
														"timeOfSample": deviceJSON.state.time,
														"uncertaintyInMilliseconds": 10000
													});
											}
											break;
										case "LockController":
											// Return Lock State
											if (deviceJSON.state.hasOwnProperty('lock') && deviceJSON.state.hasOwnProperty('time')) {
												properties.push({
														"namespace": "Alexa.LockController",
														"name": "lockState",
														"value": deviceJSON.state.lock,
														"timeOfSample": deviceJSON.state.time,
														"uncertaintyInMilliseconds": 10000
													});
											}
											break;
										case "PlaybackController":
											// Return Playback State - no reportable state as of November 2018
											break;
										case "PercentageController":
											// Return Power State
											if (deviceJSON.state.hasOwnProperty('percentage') && deviceJSON.state.hasOwnProperty('time')) {
												properties.push({
															"namespace": "Alexa.PercentageController",
															"name": "percentage",
															"value": deviceJSON.state.percentage,
															"timeOfSample": deviceJSON.state.time,
															"uncertaintyInMilliseconds": 10000
													});
											}
											break;
										case "PowerController":
											// Return Power State
											if (deviceJSON.state.hasOwnProperty('power') && deviceJSON.state.hasOwnProperty('time')) {
												properties.push({
															"namespace": "Alexa.PowerController",
															"name": "powerState",
															"value": deviceJSON.state.power,
															"timeOfSample": deviceJSON.state.time,
															"uncertaintyInMilliseconds": 10000
													});
											}
											break;
										case "TemperatureSensor":
											// Return temperature
											if (deviceJSON.state.hasOwnProperty('temperature') && deviceJSON.state.hasOwnProperty('time')) {
												properties.push({
													"namespace": "Alexa.TemperatureSensor",
													"name": "temperature",
													"value": {
														"value": deviceJSON.state.temperature,
														"scale": deviceJSON.attributes.temperatureScale.toUpperCase()
													  },
													"timeOfSample": deviceJSON.state.time,
													"uncertaintyInMilliseconds": 10000
												});
											}
											break;
										case "ThermostatController":
											// Return thermostatSetPoint
											if (deviceJSON.state.hasOwnProperty('thermostatSetPoint') && deviceJSON.state.hasOwnProperty('thermostatMode') && deviceJSON.state.hasOwnProperty('time')) {
												properties.push({
														"namespace":"Alexa.ThermostatController",
														"name":"targetSetpoint",
														"value":{  
															"value":deviceJSON.state.thermostatSetPoint,
															"scale":deviceJSON.attributes.temperatureScale.toUpperCase()
															},
														"timeOfSample":deviceJSON.state.time,
														"uncertaintyInMilliseconds":10000
													});
												properties.push({
														"namespace":"Alexa.ThermostatController",
														"name":"thermostatMode",
														"value":deviceJSON.state.thermostatMode,
														"timeOfSample":deviceJSON.state.time,
														"uncertaintyInMilliseconds":10000
													});
											}
											break;
									}
								});
								
								properties.push({
									"namespace": "Alexa.EndpointHealth",
									"name": "connectivity",
									"value": {
									  "value": "OK"
									},
									"timeOfSample": deviceJSON.state.time,
									"uncertaintyInMilliseconds": 10000
								});
								logger.log('debug', "[State API] State response properties: " + JSON.stringify(properties));
								res.status(200).json(properties);
								}
							else {
								// Device has no state, return as such
								logger.log('warn',"[State API] No state found for username: " + req.user.username + " endpointId:" + id);
								res.status(500).send();
							}
						}
						// State reporting not enabled for device, send error code
						else {
							logger.log('debug',"[State API] State requested for user: " + req.user.username + " device: " + id +  " but device state reporting disabled");
							var properties = [];
							properties.push({
								"namespace": "Alexa.EndpointHealth",
								"name": "connectivity",
								"value": {
								  "value": "OK"
								},
								"timeOfSample": deviceJSON.state.time,
								"uncertaintyInMilliseconds": 10000
							});

							//res.status(500).send();
							res.status(200).json(properties);
						}
					}
					// 'reportState' element missing on device, send error code
					else {
						logger.log('warn', "[State API] User: " + req.user.username + " device: " + id +  " has no reportState attribute, check MongoDB schema");
						res.status(500).send();
					}
				}
		});
 	}
);

///////////////////////////////////////////////////////////////////////////
// Set State API (Not in Use)
///////////////////////////////////////////////////////////////////////////
router.post('/setstate/:dev_id',
	passport.authenticate(['bearer', 'basic'], { session: false }),
	function(req,res,next){
		// do nothing, disused for now, may use along side command API 
	}
);

///////////////////////////////////////////////////////////////////////////
// Start Alexa Command API v2 (replaces much of the Lambda functionality)
///////////////////////////////////////////////////////////////////////////
router.post('/command2',
	passport.authenticate('bearer', { session: false }),
	function(req,res,next){
		var params = {
			ec: "Command",
			ea: req.body.directive.header ? "Command API directive:" + req.body.directive.header.name + ", username: " + req.user.username + ", endpointId:" + req.body.directive.endpoint.endpointId : "Command API directive",
			uid: req.user.username,
			uip: req.ip,
			dp: "/api/v1/command"
		  }
		if (enableAnalytics) {visitor.event(params).send()};

		Devices.findOne({username:req.user.username, endpointId:req.body.directive.endpoint.endpointId}, function(err, data){
			if (err) {
				logger.log('warn', "[Command API] Unable to lookup device: " + req.body.directive.endpoint.endpointId + " for user: " + req.user.username);
				res.status(404).send();	
			}
			if (data) {
				//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
				// Revised Command API Router, offloading from Lambda to avoid multiple requests/ data comparison
				//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
				logger.log('debug', "[Command API] Received command: " + JSON.stringify(req.body));
				// Convert "model" object class to JSON object
				var deviceJSON = JSON.parse(JSON.stringify(data));
				var endpointId = req.body.directive.endpoint.endpointId;
				var messageId = req.body.directive.header.messageId;
				var oauth_id = req.body.directive.endpoint.scope.token;
				var correlationToken = req.body.directive.header.correlationToken;
				var dt = new Date();
				var name = req.body.directive.header.name;
				var namespace = req.body.directive.header.namespace;
				// Build Header
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
				if (namespace == "Alexa.ChannelController") {
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
				if (namespace == "Alexa.ColorController") {
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
				if (namespace == "Alexa.ColorTemperatureController") {
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
				if (namespace == "Alexa.InputController") {
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
				if (namespace == "Alexa.LockController") {
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
				// Build PercentageController Response Context
				if (namespace == "Alexa.PercentageController") {
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
				if (namespace == "Alexa.PlaybackController") {
					var contextResult = {
						"properties": []
					};
				}
				// Build PowerController Response Context
				if (namespace == "Alexa.PowerController") {
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
				// Build Scene Controller Activation Started Event
				if (namespace == "Alexa.SceneController") {
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
				if (namespace == "Alexa.Speaker") {
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
				if (namespace == "Alexa.StepSpeaker") {
					var contextResult = {
						"properties": []
						};
				}
				//Build Thermostat Controller Response Context - AdjustTargetTemperature/ SetTargetTemperature
				if (namespace == "Alexa.ThermostatController" 
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
						var countModes = deviceJSON.attributes.thermostatModes.length;
						var arrModes = deviceJSON.attributes.thermostatModes;
						if (countModes == 1){ // If single mode is supported leave as-is
							newMode = deviceJSON.state.thermostatMode;
						}
						else {
							var auto, heat, cool, on, off = false;
							if (arrModes.indexOf('AUTO') > -1){auto = true};
							if (arrModes.indexOf('HEAT') > -1){heat = true};
							if (arrModes.indexOf('COOL') > -1){cool = true};
							if (arrModes.indexOf('ON') > -1){on = true};
							if (arrModes.indexOf('OFF') > -1){off = true};
							if (countModes == 2 && (on && off)) { // On and Off Supported
								if (newTemp < deviceJSON.state.thermostatSetPoint ) {newMode = "OFF"}
								else {newMode = "ON"}
							}
							else if (countModes == 2 && (heat && cool)) { // Cool and Heat Supported
								if (newTemp < deviceJSON.state.thermostatSetPoint ) {newMode = "COOL"}
								else {newMode = "HEAT"}
							}
							else if (countModes == 3 && (heat && cool && auto)) { // Heat, Cool and Auto Supported
								if (newTemp < deviceJSON.state.thermostatSetPoint ) {newMode = "COOL"}
								else {newMode = "HEAT"}
							}
							else if (countModes == 5 && (on && off && on && off && auto)) { // All Modes Supported
								if (newTemp < deviceJSON.state.thermostatSetPoint ) {newMode = "COOL"}
								else {newMode = "HEAT"}
							}
							else { // Fallback position
								newMode = "HEAT";
							}
						}
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
				if (namespace == "Alexa.ThermostatController" && name == "SetThermostatMode") {
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
				// Default Response Format (payload is empty)
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
				// SceneController Specific Event
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

				logger.log('debug', "[Command API] Command response:" + response);

				// Prepare MQTT topic/ message validation
				var topic = "command/" + req.user.username + "/" + req.body.directive.endpoint.endpointId;
				var validationStatus = true;

				// Cleanup MQTT message
				delete req.body.directive.header.correlationToken;
				delete req.body.directive.endpoint.scope.token;
				var message = JSON.stringify(req.body);
				logger.log('debug', "[Command API] Received command API request for user: " + req.user.username + " command: " + message);

				//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

				// Check attributes.colorTemperatureRange, send 417 to Lambda (VALUE_OUT_OF_RANGE) response if values are out of range
				if (namespace == "Alexa.ColorTemperatureController" && name == "SetColorTemperature") {
					var compare = req.body.directive.payload.colorTemperatureInKelvin;
					// Handle Out of Range
					var hasColorTemperatureRange = getSafe(() => deviceJSON.attributes.colorTemperatureRange);
					if (hasColorTemperatureRange != undefined) {
						if (compare < deviceJSON.attributes.colorTemperatureRange.temperatureMinK || compare > deviceJSON.attributes.colorTemperatureRange.temperatureMaxK) {
							logger.log('warn', "[Command API] User: " + req.user.username + ", requested color temperature: " + compare + ", on device: " + req.body.directive.endpoint.endpointId + ", which is out of range: " + JSON.stringify(deviceJSON.attributes.colorTemperatureRange));
							// Send 417 HTTP code back to Lamnda, Lambda will send correct error message to Alexa
							res.status(417).send();
							validationStatus = false;
						}
					}
					else {logger.log('debug', "[Command API] Device: " + req.body.directive.endpoint.endpointId + " does not have attributes.colorTemperatureRange defined")}
				}

				// Check attributes.temperatureRange, send 416 to Lambda (TEMPERATURE_VALUE_OUT_OF_RANGE) response if values are out of range
				if (req.body.directive.header.namespace == "Alexa.ThermostatController" && req.body.directive.header.name == "SetTargetTemperature") {
					var compare = req.body.directive.payload.targetSetpoint.value;
					// Handle Temperature Out of Range
					var hasTemperatureRange = getSafe(() => deviceJSON.attributes.temperatureRange);
					if (hasTemperatureRange != undefined) {
						if (compare < deviceJSON.attributes.temperatureRange.temperatureMin || compare > deviceJSON.attributes.temperatureRange.temperatureMax) {
							logger.log('warn', "[Command API] User: " + req.user.username + ", requested temperature: " + compare + ", on device: " + req.body.directive.endpoint.endpointId + ", which is out of range: " + JSON.stringify(deviceJSON.attributes.temperatureRange));
							// Send 416 HTTP code back to Lamnda, Lambda will send correct error message to Alexa
							res.status(416).send();
							validationStatus = false;
						}
					}
					else {logger.log('debug', "[Command API] Device: " + req.body.directive.endpoint.endpointId + " does not have attributes.temperatureRange defined")}
				}
				
				if (validationStatus) {
					try{
						mqttClient.publish(topic,message);
						logger.log('info', "[Command API] Published MQTT command for user: " + req.user.username + " topic: " + topic);
					} catch (err) {
						logger.log('warn', "[Command API] Failed to publish MQTT command for user: " + req.user.username);
					}
					var command = {
						user: req.user.username,
						res: res,
						response: response,
						source: "Alexa",
						timestamp: Date.now()
					};
			
					// Command drops into buffer w/ 6000ms timeout (see defined funcitonm above) - ACK comes from N/R flow
					onGoingCommands[req.body.directive.header.messageId] = command;
				}
			}
		});
	}
);
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// End Command API v2
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
// MQTT Message Handlers
///////////////////////////////////////////////////////////////////////////
var onGoingCommands = {};

// Event handler for received MQTT messages - note subscribe near top of script.
mqttClient.on('message',function(topic,message){
	var arrTopic = topic.split("/"); 
	var username = arrTopic[1];
	var endpointId = arrTopic[2];

	if (topic.startsWith('response/')){
		logger.log('info', "[Command API] Acknowledged MQTT response message for topic: " + topic);
		if (debug == "true") {console.time('mqtt-response')};
		var payload = JSON.parse(message.toString());
		//console.log("response payload", payload)
		var commandWaiting = onGoingCommands[payload.messageId];
		if (commandWaiting) {
			//console.log("mqtt response: " + JSON.stringify(payload,null," "));
			if (payload.success) {
				// Alexa success response send to Lambda for full response construction
				if (commandWaiting.hasOwnProperty('source') && commandWaiting.source == "Alexa") {
					if (commandWaiting.hasOwnProperty('response')) {
						logger.log('debug', "[Command API] Successful Alexa MQTT command, response: " + JSON.stringify(commandWaiting.response));
						commandWaiting.res.status(200).json(commandWaiting.response)
					}
					else {
						logger.log('debug', "[Command API] Alexa MQTT command successful");
						commandWaiting.res.status(200).send()
					}
				}			
			} else {
				// Alexa failure response send to Lambda for full response construction
				if (commandWaiting.hasOwnProperty('source') && commandWaiting.source == "Alexa") {
					if (commandWaiting.hasOwnProperty('response')) {
						logger.log('warn', "[Command API] Failed Alexa MQTT Command API, response:" + + JSON.stringify(commandWaiting.response));
						commandWaiting.res.status(503).json(commandWaiting.response)
					}
					else {
						logger.log('warn', "[Command API] Failed Alexa MQTT Command API response");
						commandWaiting.res.status(503).send()
					}
				}
			}
			delete onGoingCommands[payload.messageId];
			var params = {
				ec: "Command",
				ea: "Command API successfully processed MQTT command for username: " + username,
				uid: username,
			  }
			if (enableAnalytics) {visitor.event(params).send()};
		}
		if (debug == "true") {console.timeEnd('mqtt-response')};
	}
	else if (topic.startsWith('state/')){
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
			} else {
				logger.log('warn', "[State API] Failed MQTT state update for user:" + username + " device:" + endpointId);
				stateWaiting.res.status(503).send();
			}
		}
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
		logger.log('debug', "[MQTT] Unhandled MQTT via on message event handler: " + topic + message);
	}
});

// Interval funciton, runs every 500ms once defined via setInterval: https://www.w3schools.com/js/js_timing.asp
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

// Set State Function, sets device "state" element in MongoDB based upon Node-RED MQTT 'state' message
function setstate(username, endpointId, payload) {
	// Check payload has state property
	logger.log('debug', "[State API] SetState payload:" + JSON.stringify(payload));
	if (payload.hasOwnProperty('state')) {
		// Find existing device, we need to retain state elements, state is fluid/ will contain new elements so flattened input no good

		// Add promises here that find Grant Code for Google Application to only call JWT state submission if count > 0

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
						// Test Ghome Home Graoh API Request Token 
						requestToken().catch(function(e) {
							logger.log('error', "[State API] GHome JWT requestToken failed, error:" + e);
						});
					}
					else {logger.log('debug', "[State API] Updated state for endpointId: " + endpointId);}
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
// GHome HomeGraph Token Request
async function requestToken(keys) {
	if (reportState == true) {
		var payload = {
				"iss": keys.client_email,
				"scope": "https://www.googleapis.com/auth/homegraph",
				"aud": "https://accounts.google.com/o/oauth2/token",
				"iat": new Date().getTime()/1000,
				"exp": new Date().getTime()/1000 + 3600,
		}
		// Use jsonwebtoken to sign token
		// Sign token: https://cloud.google.com/endpoints/docs/openapi/service-account-authentication#using_jwt_signed_by_service_account
		var privKey = keys.private_key;
		var token = jwt.sign(payload, privKey, { algorithm: 'RS256'});
		// Need submit token using: application/x-www-form-urlencoded
		// Use form: https://www.npmjs.com/package/request#forms
		// Also include grant_type in form data : urn:ietf:params:oauth:grant-type:jwt-bearer
		request.post({
			url: 'https://accounts.google.com/o/oauth2/token',
			form: {
				grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
				assertion: token
				}
			},
			function(err,res, body){
				if (err) {
					logger.log('warn', "[State API] Ghome JWT / OAuth token request failed");
				} else {
					var oauthToken = JSON.parse(body).access_token;
					logger.log('info', "[State API] Ghome JWT / OAuth token:" + JSON.stringify(oauthToken));
				}
			}
		);
	}
}

module.exports = router;


