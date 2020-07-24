///////////////////////////////////////////////////////////////////////////
// Depends
///////////////////////////////////////////////////////////////////////////
var express = require('express');
var router = express.Router();
var bodyParser = require('body-parser');
router.use(bodyParser.urlencoded({ extended: true }));
router.use(bodyParser.json());
var Devices = require('../models/devices');
var passport = require('passport');
var logger = require('../loaders/logger');
var mqttClient = require('../loaders/mqtt').mqttClient;
var ongoingCommands = require('../loaders/mqtt').ongoingCommands;
const defaultLimiter = require('../loaders/limiter').defaultLimiter;
const getStateLimiter = require('../loaders/limiter').getStateLimiter;
///////////////////////////////////////////////////////////////////////////
// Functions
///////////////////////////////////////////////////////////////////////////
const updateUserServices = require('../services/func-services').updateUserServices;
const queryDeviceStateAsync = require('../services/func-alexa').queryDeviceStateAsync;
const replaceCapability = require('../services/func-alexa').replaceCapabilityAsync;
const saveGrantAsync = require('../services/func-alexa').saveGrantAsync;
const requestAccessTokenAsync = require('../services/func-alexa').requestAccessTokenAsync;
const validateCommandAsync = require('../services/func-alexa').validateCommandAsync;
const buildCommandResponseAsync = require('../services/func-alexa').buildCommandResponseAsync;
const sendEventUid = require('../services/ganalytics').sendEventUid;
///////////////////////////////////////////////////////////////////////////
// Discovery API, can be tested via credentials of an account/ browsing to http://<hostname>/api/v1/devices
///////////////////////////////////////////////////////////////////////////
router.get('/devices',
	passport.authenticate(['bearer', 'basic'], { session: false }),
	async (req, res) => {
		try {
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
			logger.log('debug', "[Alexa Discovery] Alexa Discovery response for user: " + req.user.username + ", response: " + JSON.stringify(devs));
			res.send(devs);
		}
		catch(e) {
			logger.log('error', "[Alexa Discovery] Error getting device data for: " + req.user.username + ", error: " + e.stack);
			res.status(500).send();
		}

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
			if (!req.user.activeServices || (req.user.activeServices && req.user.activeServices.indexOf("Amazon")) == -1) {updateUserServices(req.user.username, "Amazon")};
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
// Start Alexa Command API v2 (replaces much of the Lambda functionality)
///////////////////////////////////////////////////////////////////////////
router.post('/command2',
	passport.authenticate('bearer', { session: false }),
	async (req, res) => {
		try {
			sendEventUid(req.path, "Command", "Execute Command, endpointId: " + req.body.directive.endpoint.endpointId, req.ip, req.user.username, req.headers['user-agent']);
			// User has generated a command, thus must have Alexa linked with their account, add 'Amazon' to active services
			if (!req.user.activeServices || (req.user.activeServices && req.user.activeServices.indexOf("Amazon")) == -1) {updateUserServices(req.user.username, "Amazon")};
			logger.log('debug', "[Alexa API] Received command for user: " + req.user.username + ", command: " + JSON.stringify(req.body));
			// Find matching device
			var device = await Devices.findOne({username:req.user.username, endpointId:req.body.directive.endpoint.endpointId});
			// Validate command against any limits set on devices
			var validation = await validateCommandAsync(device, req);
			// Validation returned false, check response code and send relevant failure back
			if (validation.status == false) {
				if (validation.response == 416) return res.status(416).send();
				else if (validation.response == 417) return res.status(417).send();
				else {return res.status(500).send()}
			}
			// Build capability/ device-specific JSON response
			var response = await buildCommandResponseAsync(device, req);
			// If response undefined, return error 500 status
			if (response == undefined) return res.status(500).send()
			//logger.log('debug', "[Alexa API] Command response: " + response);
			// Generate MQTT topic
			var topic = "command/" + req.user.username + "/" + req.body.directive.endpoint.endpointId;
			// Cleanup req.body prior to using as source for MQTT command message
			delete req.body.directive.header.correlationToken;
			delete req.body.directive.endpoint.scope.token;
			// Generate MQTT command message
			var message = JSON.stringify(req.body);
			logger.log('debug', "[Alexa Command] Received command API request for user: " + req.user.username + " command: " + message);
			// Send Command to MQTT broker
			mqttClient.publish(topic,message);
			logger.log('info', "[Alexa Command] Published MQTT command for user: " + req.user.username + " topic: " + topic);
			// Build 'command' object used to track acknowledgement
			var command = {
				user: req.user.username,
				userId: req.user._id,
				res: res,
				response: response,
				source: "Alexa",
				timestamp: Date.now()
			};
			// Add command object to ongoingCommands for tracking
			ongoingCommands[req.body.directive.header.messageId] = command;
			//client.hset(req.body.directive.header.messageId, 'command', command); // Command drops into redis database, used to generate failure messages if not ack
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
			logger.log('info', "[AlexaAuth] Received authorisation request, body: " + JSON.stringify(req.body));
			var messageId = req.body.directive.header.messageId;
			var grantcode = req.body.directive.payload.grant.code;
			// Pre-build success and failure responses
			var success = {
					event: {
					header: {
						namespace: "Alexa.Authorization",
						name: "AcceptGrant.Response",
						messageId: messageId,
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
			// Save GrantCode
			var grant = await saveGrantAsync(req.user, grantcode);
			if (grant != undefined) {
				// Send 200 response
				res.status(200).json(success);
				logger.log('debug', "[AlexaAuth] Sent authorisation response for user :" + req.user.username + ",  body: " + JSON.stringify(success));
				// Async, test Grant Code by requesting an Access Token for user
				var accessToken = await requestAccessTokenAsync(req.user);
				// Failure, return undefined
				if (accessToken == undefined) logger.log('error', "[AlexaAuth] Failed to obtain AccessToken for user: " + req.user.username);
			}
			else {
				logger.log('error', "[AlexaAuth] General authorisation failure, sending: " + JSON.stringify(failure));
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


