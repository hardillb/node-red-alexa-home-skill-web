///////////////////////////////////////////////////////////////////////////
// Depends
///////////////////////////////////////////////////////////////////////////
var express = require('express');
var router = express.Router();
var mqttClient = require('../loaders/mqtt').mqttClient;
var logger = require('../loaders/logger');
var client = require('../loaders/redis-limiter');
///////////////////////////////////////////////////////////////////////////
// Schema
///////////////////////////////////////////////////////////////////////////
var Devices = require('../models/devices');
///////////////////////////////////////////////////////////////////////////
// Variables
///////////////////////////////////////////////////////////////////////////

///////////////////////////////////////////////////////////////////////////
// Rate-limiter
///////////////////////////////////////////////////////////////////////////
const limiter = require('express-limiter')(router, client)
// Default Limiter, used on majority of routers ex. OAuth2-related and Command API
module.exports.defaultLimiter = limiter({
	lookup: function(req, res, opts, next) {
		//opts.lookup = 'connection.remoteAddress'
		opts.lookup = 'headers.x-forwarded-for'
		opts.total = 100
		opts.expire = 1000 * 60 * 60
		return next()
  },
	onRateLimited: function (req, res, next) {
		logger.log('warn', "[Rate Limiter] Default rate-limit exceeded for path: " + req.path + ", IP address: " + req.ip)
		res.status(429).json('Rate limit exceeded');
	  }
});
// Restrictive Limiter, used to prevent abuse on NewUser, Login, 10 reqs/ hr
module.exports.restrictiveLimiter = limiter({
	lookup: function(req, res, opts, next) {
		//opts.lookup = 'connection.remoteAddress'
		opts.lookup = 'headers.x-forwarded-for'
		opts.total = 10
		opts.expire = 1000 * 60 * 60
		return next()
  },
	onRateLimited: function (req, res, next) {
		logger.log('warn', "[Rate Limiter] Restrictive rate-limit exceeded for path: " + req.path + ",  IP address:" + req.ip)
		res.status(429).json('Rate limit exceeded');
	}
});
// GetState Limiter, uses specific param, 100 reqs/ hr
module.exports.getStateLimiter = limiter({
	lookup: function(req, res, opts, next) {
		  opts.lookup = ['params.dev_id']
		  opts.total = 100
		  opts.expire = 1000 * 60 * 60
		  return next()
	},
	onRateLimited: function (req, res, next) {
		logger.log('warn', "[Rate Limiter] GetState rate-limit exceeded for IP address: " + req.ip)
		// MQTT message code, will provide client-side notification in Node-RED console
		var endpointId = (req.params.dev_id || 0);
		if (endpointId != 0) {
			// New Redis hash-based lookup
			var strAlert;
			client.hgetall(endpointId, function(err, object) {
				// No endpointId:username match in Redis, query MongoDB
				if (!err && object == undefined) {
					var pDevice = Devices.findOne({endpointId:endpointId});
					Promise.all([pDevice]).then(([device]) => {
						var username = getSafe(() => device.username);
						if (username != undefined) {
							strAlert = '[' + device.friendlyName + '] ' + 'API Rate limiter triggered. You will be unable to view state in Alexa App for up to 1 hour. Please refrain from leaving Alexa App open/ polling for extended periods, see wiki for more information.';
							// Add endpointId : username | friendlyName hash to Redis as its likely we'll get repeat hits!
							client.hset(endpointId, 'username', device.username, 'deviceFriendlyName', device.friendlyName);
							notifyUser('warn', username, endpointId, strAlert);
						}
						else {
							logger.log('warn', "[Rate Limiter] GetState rate-limit unable to lookup username");
						}
					});
				}
				// Matched endpointId hash in Redis, saved MongoDB query
				else if (!err) {
					strAlert = '[' + object.deviceFriendlyName + '] ' + 'API Rate limiter triggered. You will be unable to view state in Alexa App for up to 1 hour. Please refrain from leaving Alexa App open/ polling for extended periods, see wiki for more information.';
					notifyUser('warn', object.username, endpointId, strAlert);
				}
				// An error occurred on Redis client.get
				else {
					logger.log('warn', "[Rate Limiter] Redis get failed with error: " + err);
				}
			});
		}
		else {
			logger.log('verbose', "[Rate Limiter] GetState rate-limit unable to lookup dev_id param");
		}
		res.status(429).json('Rate limit exceeded for GetState API');
	  }
  });

  // Post MQTT message that users' Node-RED instance will display in GUI as warning
function notifyUser(severity, username, endpointId, message){
	var topic = "message/" + username + "/" + endpointId; // Prepare MQTT topic for client-side notifiations
	var alert = {};
	alert.severity = severity;
	alert.message = message
	try{
		mqttClient.publish(topic,JSON.stringify(alert));
		logger.log('warn', "[Limiter] Published MQTT alert for user: " + username + " endpointId: " + endpointId + " message: " + message);
	} catch (err) {
		logger.log('warn', "[Limiter] Failed to publish MQTT alert, error: " + err);
	}
};

// Nested attribute/ element tester
function getSafe(fn) {
	try {
		return fn();
    } catch (e) {
        return undefined;
    }
}