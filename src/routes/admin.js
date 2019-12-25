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
var BasicStrategy = require('passport-http').BasicStrategy;
var LocalStrategy = require('passport-local').Strategy;
var countries = require('countries-api');
var logger = require('../loaders/logger');
const defaultLimiter = require('../loaders/limiter').defaultLimiter;
const restrictiveLimiter = require('../loaders/limiter').restrictiveLimiter;
const sendPageView = require('../services/ganalytics').sendPageView;
const sendPageViewUid = require('../services/ganalytics').sendPageViewUid;
const sendEventUid = require('../services/ganalytics').sendEventUid;
///////////////////////////////////////////////////////////////////////////
// Variables
///////////////////////////////////////////////////////////////////////////
//var debug = (process.env.ALEXA_DEBUG || false);
// MQTT Settings  =========================================
var mqtt_user = (process.env.MQTT_USER);
///////////////////////////////////////////////////////////////////////////
// Passport Configuration
///////////////////////////////////////////////////////////////////////////
passport.use(new LocalStrategy(Account.authenticate()));
passport.use(new BasicStrategy(Account.authenticate()));
passport.serializeUser(Account.serializeUser());
passport.deserializeUser(Account.deserializeUser());
///////////////////////////////////////////////////////////////////////////
// Services
///////////////////////////////////////////////////////////////////////////
router.get('/services', defaultLimiter,
	ensureAuthenticated,
	function(req,res){
		if (req.user.username === mqtt_user) {
			sendPageViewUid(req.path, 'Services Admin', req.ip, req.user.username, req.headers['user-agent']);
			const pApplications = oauthModels.Application.find({});
			Promise.all([pApplications]).then(([apps]) => {
					res.render('pages/services',{user:req.user, services: apps, title: "OAuth Services | Node-RED Smart Home Control"});
				}).catch(err => {
					res.status(500).json({error: err});
				});
		} else {
			//res.status(401).send();
			res.redirect(303, '/');
		}
});
///////////////////////////////////////////////////////////////////////////
// Users
///////////////////////////////////////////////////////////////////////////
router.get('/users', defaultLimiter,
	ensureAuthenticated,
	function(req,res){
		if (req.user.username === mqtt_user) {
			// https://docs.mongodb.com/manual/reference/method/db.collection.find/#explicitly-excluded-fields
			sendPageViewUid(req.path, 'User Admin', req.ip, req.user.username, req.headers['user-agent']);
			const pCountUsers = Account.countDocuments({});
			const pUsersAndCountDevices = Account.aggregate([
				{ "$lookup": {
					"from": "devices",
					"let": { "username": "$username" },
					"pipeline": [
					  { "$match": {
						"$expr": { "$eq": [ "$$username", "$username" ] }
					  }},
					  { "$count": "count" }
					],
					"as": "deviceCount"
				  }},
				  { "$addFields": {
					"countDevices": { "$sum": "$deviceCount.count" }
				  }}
			 ]);
			Promise.all([pCountUsers, pUsersAndCountDevices]).then(([totalCount, usersAndDevs]) => {
				res.render('pages/users',{user:req.user, users: usersAndDevs, usercount: totalCount, title: "User Admin | Node-RED Smart Home Control"});
			}).catch(err => {
				res.status(500).json({error: err});
			});
		}
		else {
			//res.status(401).send();
			res.redirect(303, '/');
		}
});
///////////////////////////////////////////////////////////////////////////
// User Disable/ Enable
///////////////////////////////////////////////////////////////////////////
router.post('/user/:id/:state', defaultLimiter,
	ensureAuthenticated,
	function(req,res){
		if (req.user.username === mqtt_user) {
			if (req.params.id && req.params.state) {
				// Convert string input to boolean
				var state = (req.params.state === "true");
				toggleUser(req.params.id, state)
					.then(result => {
						if (result == true) {
							req.flash('success_messages', 'Updated Account State!');
							return res.status(200).send();
						}
						else {
							req.flash('error_messages', 'Error updating account state!');
							return res.status(400).send("Error updating account state!");
						}
					})
					.catch(e => {
						//sendEventUid(req.path, "Security", "Failed to Changed Password", req.ip, req.user.username, req.headers['user-agent']);
						req.flash('error_messages', 'Error updating account state!');
						//res.locals.error_messages = 'Error setting new password!';
						return res.status(400).send("Error updating account state!");
					})
			}
		}
		else {
			//res.status(401).send();
			res.redirect(303, '/');
		}
});

///////////////////////////////////////////////////////////////////////////
// User Devices
///////////////////////////////////////////////////////////////////////////
router.get('/user-devices', defaultLimiter,
	ensureAuthenticated,
	function(req,res){
		if (req.user.username === mqtt_user) {
			sendPageViewUid(req.path, 'User Device Admin', req.ip, req.user.username, req.headers['user-agent']);
			const pUserDevices = Devices.find({});
			const pCountDevices = Devices.countDocuments({});
			Promise.all([pUserDevices, pCountDevices]).then(([devices, count]) => {
				res.render('pages/user-devices',{user:req.user, devices: devices, devicecount: count, title: "Device Admin | Node-RED Smart Home Control"});
			}).catch(err => {
				res.status(500).json({error: err});
			});
		} else {
				//res.status(401).send();
				res.redirect(303, '/');
			}
});
///////////////////////////////////////////////////////////////////////////
// Services (Put)
///////////////////////////////////////////////////////////////////////////
router.put('/services', defaultLimiter,
ensureAuthenticated,
function(req,res){
    if (req.user.username == mqtt_user) {
        var application = oauthModels.Application(req.body);
        application.save(function(err, application){
            if (!err) {
                res.status(201).send(application);
            }
        });
    } else {
		//res.status(401).send();
		res.redirect(303, '/');
    }
});
///////////////////////////////////////////////////////////////////////////
// Service (Post)
///////////////////////////////////////////////////////////////////////////
router.post('/service/:id', defaultLimiter,
ensureAuthenticated,
function(req,res){
	var service = req.body;
	if (req.user.username == mqtt_user) {
		oauthModels.Application.findOne({_id: req.params.id},
			function(err,data){
				if (err) {
						res.status(500);
						res.send(err);
					} else {
						data.title = service.title;
						data.oauth_secret = service.oauth_secret;
						data.domains = service.domains;
						data.save(function(err, d){
							res.status(201);
							res.send(d);
						});
					}
			});
	} else {
		//res.status(401).send();
		res.redirect(303, '/');
    }
});
///////////////////////////////////////////////////////////////////////////
// Service (Delete)
///////////////////////////////////////////////////////////////////////////
router.delete('/service/:id', defaultLimiter,
ensureAuthenticated,
function(req,res){
	if (req.user.username == mqtt_user) {
		oauthModels.Application.remove({_id:req.params.id},
			function(err){
				if (!err) {
					res.status(200).send();
				} else {
					res.status(500).send();
				}
			});

	} else {
		//res.status(401).send();
		res.redirect(303, '/');
	}
});
///////////////////////////////////////////////////////////////////////////
// Functions
///////////////////////////////////////////////////////////////////////////
function ensureAuthenticated(req,res,next) {
	//console.log("ensureAuthenticated - %j", req.isAuthenticated());
	//console.log("ensureAuthenticated - %j", req.user);
	//console.log("ensureAuthenticated - %j", req.session);
	if (req.isAuthenticated()) {
    	return next();
	} else {
		//console.log("failed auth?");
		res.redirect('/login');
	}
}

const toggleUser = async(id, enabled) => {
	try {
		// Find User
		var user = await Account.findOne({_id: id});
		// Set Account Status
		if (enabled == true && user.username != mqtt_user) {
			user.active = true
			logger.log('verbose', "[Admin] Enabling User Account: " + user.username);
		}
		else if (enabled == false && user.username != mqtt_user) {
			user.active = false
			logger.log('verbose', "[Admin] Disabling User Account: " + user.username);
		}
		else {
			logger.log('error', "[Admin] toggleUser invalid state requested: " + enabled);
			return false;
		}
		// Save Account
		await user.save();
		logger.log('verbose', "[Admin] Account saved following 'active' element change: " + user.username);
		return true;
	}
	catch(e) {
		logger.log('error', "[Admin] Unable to change user 'active' element, error: " + e);
		return false;
	}
}

module.exports = router;