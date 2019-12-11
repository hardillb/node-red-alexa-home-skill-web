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
var logger = require('../config/logger');
var ua = require('universal-analytics');
var client = require('../config/redis')
///////////////////////////////////////////////////////////////////////////
// Variables
///////////////////////////////////////////////////////////////////////////
var debug = (process.env.ALEXA_DEBUG || false);
// MQTT Settings  =========================================
var mqtt_user = (process.env.MQTT_USER);
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
// Services
///////////////////////////////////////////////////////////////////////////
router.get('/services', defaultLimiter,
	ensureAuthenticated,
	function(req,res){
		if (req.user.username === mqtt_user) {
			var view = {
				dp: req.path,
				dh: 'https://' + process.env.WEB_HOSTNAME,
				dt: 'Services Admin',
				uid: req.user.username,
				uip: req.ip,
				ua: req.headers['user-agent']
			}
			if (enableAnalytics) {visitor.pageview(view).send()};

			const pApplications = oauthModels.Application.find({});
			Promise.all([pApplications]).then(([apps]) => {
					res.render('pages/services',{user:req.user, services: apps});
				}).catch(err => {
					res.status(500).json({error: err});
				});
		} else {
			res.status(401).send();
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
			var view = {
				dp: req.path,
				dh: 'https://' + process.env.WEB_HOSTNAME,
				dt: 'User Admin',
				uid: req.user.username,
				uip: req.ip,
				ua: req.headers['user-agent']
			}
			if (enableAnalytics) {visitor.pageview(view).send()};
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
				res.render('pages/users',{user:req.user, users: usersAndDevs, usercount: totalCount});
			}).catch(err => {
				res.status(500).json({error: err});
			});
		}
		else {
			res.status(401).send();
		}
});
///////////////////////////////////////////////////////////////////////////
// User Devices
///////////////////////////////////////////////////////////////////////////
router.get('/user-devices', defaultLimiter,
	ensureAuthenticated,
	function(req,res){
		if (req.user.username === mqtt_user) {
			var view = {
				dp: req.path,
				dh: 'https://' + process.env.WEB_HOSTNAME,
				dt: 'User Device Admin',
				uid: req.user.username,
				uip: req.ip,
				ua: req.headers['user-agent']
			}
			if (enableAnalytics) {visitor.pageview(view).send()};

			const pUserDevices = Devices.find({});
			const pCountDevices = Devices.countDocuments({});
			Promise.all([pUserDevices, pCountDevices]).then(([devices, count]) => {
				res.render('pages/user-devices',{user:req.user, devices: devices, devicecount: count});
			}).catch(err => {
				res.status(500).json({error: err});
			});
	} else {
			res.status(401).send();
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
        res.status(401).send();
    }
});
///////////////////////////////////////////////////////////////////////////
// Service (Post)
///////////////////////////////////////////////////////////////////////////
router.post('/service/:id', defaultLimiter,
ensureAuthenticated,
function(req,res){
    var service = req.body;
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
});
///////////////////////////////////////////////////////////////////////////
// Service (Delete)
///////////////////////////////////////////////////////////////////////////
router.delete('/service/:id', defaultLimiter,
ensureAuthenticated,
function(req,res){
    oauthModels.Application.remove({_id:req.params.id},
        function(err){
            if (!err) {
                res.status(200).send();
            } else {
                res.status(500).send();
            }
        });
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

module.exports = router;