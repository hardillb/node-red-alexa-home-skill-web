///////////////////////////////////////////////////////////////////////////
// Depends
///////////////////////////////////////////////////////////////////////////
var express = require('express');
var router = express.Router();
var bodyParser = require('body-parser');
router.use(bodyParser.urlencoded({ extended: true }));
router.use(bodyParser.json());
var sendemail = require('../sendemail');
var mailer = new sendemail();
var Account = require('../models/account');
var oauthModels = require('../models/oauth');
var Devices = require('../models/devices');
var Topics = require('../models/topics');
var LostPassword = require('../models/lostPassword');
var passport = require('passport');
var BasicStrategy = require('passport-http').BasicStrategy;
var LocalStrategy = require('passport-local').Strategy;
var countries = require('countries-api');
var logger = require('../config/logger');
var ua = require('universal-analytics');
var client = require('../config/redis')
///////////////////////////////////////////////////////////////////////////
// Functions
///////////////////////////////////////////////////////////////////////////
const gHomeFunc = require('../functions/func-ghome');
const sendState =  gHomeFunc.sendState;
const queryDeviceState = gHomeFunc.queryDeviceState;
const isGhomeUser = gHomeFunc.isGhomeUser;
const requestToken2 = gHomeFunc.requestToken2;
const gHomeSync = gHomeFunc.gHomeSync;
///////////////////////////////////////////////////////////////////////////
// Variables
///////////////////////////////////////////////////////////////////////////
var debug = (process.env.ALEXA_DEBUG || false);
var mqtt_user = (process.env.MQTT_USER);
// Google Analytics ==========================
var enableAnalytics = false;
if (process.env.GOOGLE_ANALYTICS_TID != undefined) {
    enableAnalytics = true;
    var visitor = ua(process.env.GOOGLE_ANALYTICS_TID);
}
// Google Home Sync =========================
var enableGoogleHomeSync = true;
// Warn on SYNC_API not being specified/ request SYNC will be disabled
if (!(process.env.HOMEGRAPH_APIKEY)){
	enableGoogleHomeSync = false;
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
		opts.lookup = 'connection.remoteAddress'
		opts.total = 1000
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
// Restrictive Limiter, used to prevenmt abuse on NewUser, Login, 10 reqs/ hr
const restrictiveLimiter = limiter({
	lookup: function(req, res, opts, next) {
		opts.lookup = 'connection.remoteAddress'
		opts.total = 100
		opts.expire = 1000 * 60 * 60
		return next()
  },
	onRateLimited: function (req, res, next) {
		logger.log('warn', "[Rate Limiter] Restrictive rate-limit exceeded for path: " + req.path + ",  IP address:" + req.ip)
		var params = {
			ec: "Express-limiter",
			ea: "Restrictive: rate-limited path: " + req.path + ", IP address:" + req.ip,
			uip: req.ip
		  }
		if (enableAnalytics) {visitor.event(params).send()};
		res.status(429).json('Rate limit exceeded');
	}
});
///////////////////////////////////////////////////////////////////////////
// Home
///////////////////////////////////////////////////////////////////////////
router.get('/', defaultLimiter, function(req,res){
	var view = {
		dp: req.path, 
		dh: 'https://' + process.env.WEB_HOSTNAME,
		dt: 'Home',
		uip: req.ip,
		ua: req.headers['user-agent']
	}
	if (enableAnalytics) {visitor.pageview(view).send()};

	res.render('pages/index', {user: req.user, home: true});
});
///////////////////////////////////////////////////////////////////////////
// Docs
///////////////////////////////////////////////////////////////////////////
router.get('/docs', defaultLimiter, function(req,res){
	var view = {
		dp: req.path, 
		dh: 'https://' + process.env.WEB_HOSTNAME,
		dt: 'Docs',
		uip: req.ip,
		ua: req.headers['user-agent']
	}
	if (enableAnalytics) {visitor.pageview(view).send()};

	res.render('pages/docs', {user: req.user, docs: true});
});
///////////////////////////////////////////////////////////////////////////
// About
///////////////////////////////////////////////////////////////////////////
router.get('/about', defaultLimiter, function(req,res){
	var view = {
		dp: req.path, 
		dh: 'https://' + process.env.WEB_HOSTNAME,
		dt: 'About',
		uip: req.ip,
		ua: req.headers['user-agent']
	}
	if (enableAnalytics) {visitor.pageview(view).send()};

	res.render('pages/about', {user: req.user, about: true});
});
///////////////////////////////////////////////////////////////////////////
// Privacy
///////////////////////////////////////////////////////////////////////////
router.get('/privacy', defaultLimiter, function(req,res){
	var view = {
		dp: req.path, 
		dh: 'https://' + process.env.WEB_HOSTNAME,
		dt: 'Privacy',
		uip: req.ip,
		ua: req.headers['user-agent']
	}
	if (enableAnalytics) {visitor.pageview(view).send()};

	res.render('pages/privacy', {user: req.user, privacy: true});
});
///////////////////////////////////////////////////////////////////////////
// TOS
///////////////////////////////////////////////////////////////////////////
router.get('/tos', defaultLimiter, function(req,res){
	var view = {
		dp: req.path, 
		dh: 'https://' + process.env.WEB_HOSTNAME,
		dt: 'Terms of Service',
		uip: req.ip,
		ua: req.headers['user-agent']
	}
	if (enableAnalytics) {visitor.pageview(view).send()};

	res.render('pages/tos', {user: req.user, tos: true});
});
///////////////////////////////////////////////////////////////////////////
// Login (Get)
///////////////////////////////////////////////////////////////////////////
router.get('/login', defaultLimiter, function(req,res){
	var view = {
		dp: req.path, 
		dh: 'https://' + process.env.WEB_HOSTNAME,
		dt: 'Login',
		uip: req.ip,
		ua: req.headers['user-agent']
	}
	if (enableAnalytics) {visitor.pageview(view).send()};

	res.render('pages/login',{user: req.user, login: true, message: req.flash('error')});
});
///////////////////////////////////////////////////////////////////////////
// Logout
///////////////////////////////////////////////////////////////////////////
router.get('/logout', defaultLimiter, function(req,res){
	req.logout();
	if (req.query.next) {
		//console.log(req.query.next);
		res.redirect(req.query.next);
	} else {
		res.redirect('/');
	}
	
});

///////////////////////////////////////////////////////////////////////////
// Login (Post) - restrictiveLimiter
///////////////////////////////////////////////////////////////////////////
router.post('/login', restrictiveLimiter,
	passport.authenticate('local',{ failureRedirect: '/login', failureFlash: true, session: true }),
	function(req,res){
		var params = {
			ec: "Security", // class
			ea: "Login", //action
			uid: req.user,
			uip: req.ip,
			dp: "/login"
		  }
		if (enableAnalytics) {visitor.pageview(params).send()};

		if (req.query.next) {
			res.reconnect(req.query.next);
		} else {
			if (req.user.username != mqtt_user) {
				res.redirect('/devices');
			}
			else {
				res.redirect('/admin/users');
			}
		}
    });
///////////////////////////////////////////////////////////////////////////
// Register/ Newuser (Get)
///////////////////////////////////////////////////////////////////////////
router.get('/newuser', defaultLimiter, function(req,res){
    var view = {
        dp: req.path, 
        dh: 'https://' + process.env.WEB_HOSTNAME,
        dt: 'New User',
        uip: req.ip,
        ua: req.headers['user-agent']
    }
    if (enableAnalytics) {visitor.pageview(view).send()};

    res.render('pages/register',{user: req.user, newuser: true});
});
///////////////////////////////////////////////////////////////////////////
// Register/ Newuser (Post) restrictiveLimiter
///////////////////////////////////////////////////////////////////////////
router.post('/newuser', restrictiveLimiter, function(req,res){
    var body = JSON.parse(JSON.stringify(req.body));
    if (body.hasOwnProperty('username') && body.hasOwnProperty('email') && body.hasOwnProperty('country') && body.hasOwnProperty('password')) {
		logger.log('verbose', "[New User] Looking up region for country: " + req.body.country.toUpperCase());
        const pCountry = countries.findByCountryCode(req.body.country.toUpperCase());
        Promise.all([pCountry]).then(([userCountry]) => {
			if (userCountry.statusCode == 200) {
                var region = userCountry.data[0].region;
                Account.register(new Account({ username : req.body.username, email: req.body.email, country: req.body.country.toUpperCase(), region: region,  mqttPass: "foo" }), req.body.password, function(err, account) {
                    if (err) {
                        logger.log('error', "[New User] New user creation error: " + err);
                        return res.status(400).send(err.message);
                    }
                    var topics = new Topics({topics: [
                            'command/' + account.username +'/#', 
                            'state/'+ account.username + '/#',
							'response/' + account.username + '/#',
							'message/' + account.username + '/#'
                        ]});
                    topics.save(function(err){
                        if (!err){
                            var s = Buffer.from(account.salt, 'hex').toString('base64');
                            var h = Buffer.from(account.hash, 'hex').toString(('base64'));
                            var mqttPass = "PBKDF2$sha256$901$" + account.salt + "$" + account.hash;
                            Account.updateOne(
                                {username: account.username}, 
                                {$set: {mqttPass: mqttPass, topics: topics._id}}, 
                                function(err, count){
                                    if (err) {
                                        logger.log('error' , "[New User] New user creation error updating MQTT info: " + err);
                                    }
                                }
                            );
                        }
                    });
                    passport.authenticate('local')(req, res, function () {
                        logger.log('info', "[New User] Created new user, username: " + req.body.username + " email:"  + req.body.email + " country:" +  req.body.country + " region:" + region );
                        var params = {
                            ec: "Security",
                            ea: "Create user, username:" + req.body.username + " email:"  + req.body.email + " country:" +  req.body.country + " region:" + region,
                            uid: req.user,
                            dp: "/newuser"
                        }
                        if (enableAnalytics) {visitor.event(params).send()};
                        res.status(201).send();
                    });
                });
            }
        }).catch(err => {
            logger.log('warn', "[New User] User region lookup failed, error:" + err);
            res.status(500).send("Account creation failed, please check country is correctly specified!");
        });
    }
    else {
        logger.log('warn', "[New User] Missing/ incorrect elements supplied for user account creation");
        res.status(500).send("Missing required attributes, please check registration form!");
    }
});
///////////////////////////////////////////////////////////////////////////
// changePassword/:key (Get)
///////////////////////////////////////////////////////////////////////////
router.get('/changePassword/:key', defaultLimiter, function(req, res, next){
    var uuid = req.params.key;
    LostPassword.findOne({uuid: uuid}).populate('user').exec(function(error, lostPassword){
        if (!error && lostPassword) {
            req.login(lostPassword.user, function(err){
                if (!err){
                    lostPassword.remove();
                    res.redirect('/changePassword');
                } else {
                    logger.log('warn', "[Change Password] Unable to find correlating password reset key for user: " + lostPassword.user);
                    //logger.log('debug', "[Change Password] " + err);
                    res.redirect('/');
                }
            })
        } else {
            res.redirect('/');
        }
    });
});
///////////////////////////////////////////////////////////////////////////
// changePassword (Get)
///////////////////////////////////////////////////////////////////////////
router.get('/changePassword', defaultLimiter, ensureAuthenticated, function(req, res, next){
    var view = {
        dp: req.path, 
        dh: 'https://' + process.env.WEB_HOSTNAME,
        dt: 'Change Password',
        uid: req.user.username,
        uip: req.ip,
        ua: req.headers['user-agent']
    }
    if (enableAnalytics) {visitor.pageview(view).send()};
    
    res.render('pages/changePassword', {user: req.user});
});
///////////////////////////////////////////////////////////////////////////
// changePassword (Post) restrictiveLimiter
///////////////////////////////////////////////////////////////////////////
router.post('/changePassword', defaultLimiter, ensureAuthenticated, function(req, res, next){
    Account.findOne({username: req.user.username}, function (err, user){
        if (!err && user) {
			//logger.log('debug', "[Change Password] req.body: " + JSON.stringify(req.body));
			//logger.log('debug', "[Change Password] Setting password to: " + req.body.password);
			//logger.log('debug', "[Change Password] Old hash: " + user.mqttPass);
            user.setPassword(req.body.password, function(e,u){
                //var s = Buffer.from(user.salt, 'hex').toString('base64');
                //var h = Buffer.from(user.hash, 'hex').toString(('base64'));
                var mqttPass = "PBKDF2$sha256$901$" + user.salt + "$" + user.hash;
                u.mqttPass = mqttPass;
                u.save(function(error){
                    if (!error) {
                        var params = {
                            ec: "Security",
                            ea: "Changed password for username:" + u.username,
                            uid: req.user,
                            dp: "/changePassword"
                            }
						if (enableAnalytics) {visitor.event(params).send()};
						logger.log('verbose', "[Change Password] Changed password for: " + u.username);
						//logger.log('debug', "[Change Password] New hash: " + mqttPass);
                        res.status(200).send();
                    } else {
                        logger.log('warn', "[Change Password] Unable to change password for: " + u.username);
                        logger.log('debug', "[Change Password] " + error);
                        res.status(400).send("Problem setting new password");
                    }
                });
            });
        } else {
            logger.log('warn', "[Change Password] Unable to change password for user, user not found: " + req.user.username);
            logger.log('debug', "[Change Password] " + err);
            res.status(400).send("Problem setting new password");
        }
    });
});
///////////////////////////////////////////////////////////////////////////
// lostPassword (Get)
///////////////////////////////////////////////////////////////////////////
router.get('/lostPassword', defaultLimiter, function(req, res, next){
    var view = {
        dp: req.path, 
        dh: 'https://' + process.env.WEB_HOSTNAME,
        dt: 'Lost Password',
        uip: req.ip,
        ua: req.headers['user-agent']
    }
    if (enableAnalytics) {visitor.pageview(view).send()};

    res.render('pages/lostPassword', { user: req.user});
});
///////////////////////////////////////////////////////////////////////////
// lostPassword (Post) restrictiveLimiter
///////////////////////////////////////////////////////////////////////////
router.post('/lostPassword', defaultLimiter, function(req, res, next){
    var email = req.body.email;
    Account.findOne({email: email}, function(error, user){
        if (!error){
            if (user){
                var lostPassword = new LostPassword({user: user});
                //console.log(lostPassword);
                lostPassword.save(function(err){
                    if (!err) {
                        res.status(200).send();
                    }
                    //console.log(lostPassword.uuid);
                    //console.log(lostPassword.user.username);
                    var body = mailer.buildLostPasswordBody(lostPassword.uuid, lostPassword.user.username);
                    mailer.send(email, 'nr-alexav3@cb-net.co.uk', 'Password Reset for Node-Red-Alexa-Smart-Home-v3', body.text, body.html);
                });
            } else {
                res.status(404).send("No user found with that email address");
            }
        }
    });
});
///////////////////////////////////////////////////////////////////////////
// My-Account
///////////////////////////////////////////////////////////////////////////
router.get('/my-account', defaultLimiter,
    ensureAuthenticated,
    function(req,res){
        var view = {
            dp: req.path, 
            dh: 'https://' + process.env.WEB_HOSTNAME,
            dt: 'My Account',
            uid: req.user.username,
            uip: req.ip,
            ua: req.headers['user-agent']
        }
        if (enableAnalytics) {visitor.pageview(view).send()};

        const pUser = Account.findOne({username: req.user.username});
        Promise.all([pUser]).then(([userAccount]) => {
            //logger.log('info', "userAccount: " + userAccount);
            res.render('pages/account',{user: userAccount, acc: true});
        }).catch(err => {
            res.status(500).json({error: err});
        });
});
///////////////////////////////////////////////////////////////////////////
// Devices (Get)
///////////////////////////////////////////////////////////////////////////
router.get('/devices', defaultLimiter,
	ensureAuthenticated,
	function(req,res){
		var view = {
			dp: req.path, 
			dh: 'https://' + process.env.WEB_HOSTNAME,
			dt: 'Devices',
			uid: req.user.username,
			uip: req.ip,
			ua: req.headers['user-agent']
		}
		if (enableAnalytics) {visitor.pageview(view).send()};
		var user = req.user.username;
		const pUserDevices = Devices.find({username:user});
		const pCountDevices = Devices.countDocuments({username:user});
		const pCountGrants = Account.aggregate([
			{ "$match": {
				"username" : user
			}},
			{ "$lookup": {
				"from": "grantcodes",
				"let": { "user_id": "$_id" },
				"pipeline": [
					{ "$match": {
					"$expr": { "$eq": [ "$$user_id", "$user" ] }
					}},
					{ "$count": "count" }
				],
				"as": "grantCount"    
			}},
			{ "$addFields": {
			"countGrants": { "$sum": "$grantCount.count" }
			}}
		]);

		Promise.all([pUserDevices, pCountDevices, pCountGrants]).then(([devices, countDevs, countUserGrants]) => {
			//logger.log('info', "Grant count for user: " + user + ", grants: " + countUserGrants[0].countGrants);
			//logger.log('info', "countUserGrants: " + JSON.stringify(countUserGrants));
			res.render('pages/devices',{user: req.user, devices: devices, count: countDevs, grants: countUserGrants[0].countGrants, devs: true});
		}).catch(err => {
			res.status(500).json({error: err});
		});
});
///////////////////////////////////////////////////////////////////////////
// Devices (Put)
///////////////////////////////////////////////////////////////////////////
router.put('/devices', defaultLimiter,
	ensureAuthenticated,
	function(req,res){
		var user = req.user.username;
		var device = req.body;
		device.username = user;
		//device.isReachable = true;
		var dev = new Devices(device);
		dev.save(function(err, dev){
			if (!err) {
				res.status(201)
				res.send(dev);
				logger.log('debug', "[Devices] New device created: " + JSON.stringify(dev));
				if (enableGoogleHomeSync == true){gHomeSync(req.user._id)}; // Sync changes with Google Home Graph API
			} else {
				res.status(500);
				res.send(err);
			}
		});

});
///////////////////////////////////////////////////////////////////////////
// account/:user_id (Put)
///////////////////////////////////////////////////////////////////////////
router.post('/account/:user_id', defaultLimiter,
	ensureAuthenticated,
	function(req,res){
		var user = req.body;
		if (req.user.username === mqtt_user || req.user.username == user.username) { // Check is admin user, or user themselves
			const pCountry = countries.findByCountryCode(user.country.toUpperCase());
			Promise.all([pCountry]).then(([userCountry]) => {
				if (userCountry.statusCode == 200) {
					var region = userCountry.data[0].region;
					Account.findOne({_id: req.params.user_id},
						function(err, data){
							if (err) {
								logger.log('warn', "[Update User] Unable to update user account: " + req.params.user_id, err);
								res.status(500);
								res.send();
							} else {
								if (req.user.username === mqtt_user) {
									logger.log('info', "[Update User] Superuser updated user account: " + req.params.user_id);
								}
								else {
									logger.log('info', "[Update User] Self-service user account update: " + req.params.user_id);
								}
								data.email = user.email;
								data.country = user.country.toUpperCase();
								data.region = region;
								data.save(function(err, d){
									res.status(201);
									res.send(d);
								});
							}
						});
				}
			}).catch(err => {
				logger.log('warn', "[Update User] Unable to update user account, user region lookup failed.");
				res.status(500).send("Unable to update user account, user region lookup failed!");
			});
		}
		else {
			logger.log('warn', "[Update User] Attempt to modify user account blocked");
		}
});
///////////////////////////////////////////////////////////////////////////
// Account (Delete)
///////////////////////////////////////////////////////////////////////////
router.delete('/account/:user_id', defaultLimiter,
	ensureAuthenticated,
	function(req,res){
		var userId = req.params.user_id;
		const pUser = Account.findOne({_id: userId});
		Promise.all([pUser]).then(([userAccount]) => {
			//logger.log('info', "userAccount: " + userAccount);
			//res.render('pages/account',{user: userAccount, acc: true});
			if (userAccount.username == req.user.username || req.user.username === mqtt_user) {
				const pDeleteAccount = Account.deleteOne({_id: userId});
				const pDeleteGrantCodes = oauthModels.GrantCode.deleteMany({user: userId});
				const pDeleteAccessTokens = oauthModels.AccessToken.deleteMany({user: userId});
				const pDeleteRefreshTokens = oauthModels.RefreshToken.deleteMany({user: userId});
				const pDeleteDevices = Devices.deleteMany({username: userAccount.username});
				const pDeleteTopics = Topics.deleteOne({_id:userAccount.topics});
				Promise.all([pDeleteAccount, pDeleteGrantCodes, pDeleteAccessTokens, pDeleteRefreshTokens, pDeleteDevices, pDeleteTopics]).then(result => {
					//logger.log('info', result);
					res.status(202).json({message: 'deleted'});
					if (req.user.username === mqtt_user) {
						logger.log('info', "[Delete User] Superuser deleted user account: " + userId)
					}
					else {
						logger.log('info', "[Delete User] Self-service account deletion, user account: " + userId)
					}
				}).catch(err => {
					logger.log('warn', "[Delete User] Failed to delete user account: " + userId);
					res.status(500).json({error: err});
				});
			}
			else {
				logger.log('warn', "[Delete User] Attempt to delete user account blocked");
			}
		}).catch(err => {
			logger.log('warn', "[Delete User] Failed to find user account: " + userId);
			res.status(500).send();
		});
});
///////////////////////////////////////////////////////////////////////////
// Tokens (Delete)
///////////////////////////////////////////////////////////////////////////
router.delete('/tokens/:user_id', defaultLimiter,
ensureAuthenticated,
function(req,res){
	var userId = req.params.user_id;
	const pUser = Account.findOne({_id: userId});
	Promise.all([pUser]).then(([userAccount]) => {
		if (userAccount.username == req.user.username || req.user.username === mqtt_user) {
			const pDeleteGrantCodes = oauthModels.GrantCode.deleteMany({user: userId});
			const pDeleteAccessTokens = oauthModels.AccessToken.deleteMany({user: userId});
			const pDeleteRefreshTokens = oauthModels.RefreshToken.deleteMany({user: userId});
			Promise.all([pDeleteAccount, pDeleteGrantCodes, pDeleteAccessTokens, pDeleteRefreshTokens, pDeleteDevices, pDeleteTopics]).then(result => {
				res.status(202).json({message: 'deleted OAuth tokens'});
				if (req.user.username === mqtt_user) {
					logger.log('info', "[Delete Tokens] Superuser deleted OAuth tokens for account: " + userId)
				}
				else {
					logger.log('info', "[Delete Tokens] Self-service OAuth token deletion for account: " + userId)
				}
			}).catch(err => {
				logger.log('warn', "[Delete Tokens] Failed to delete OAuth tokens for account: " + userId);
				res.status(500).json({error: err});
			});
		}
		else {
			logger.log('warn', "[Delete Tokens] Attempt to delete user OAuth tokens blocked");
		}
	}).catch(err => {
		logger.log('warn', "[Delete Tokens] Failed to find user account: " + userId);
		res.status(500).send();
	});
});
///////////////////////////////////////////////////////////////////////////
// Device (Post)
///////////////////////////////////////////////////////////////////////////
router.post('/device/:dev_id', defaultLimiter,
	ensureAuthenticated,
	function(req,res){
		var user = req.user.username;
		var id = req.params.dev_id;
		var device = req.body;
		if (user === device.username) {
			Devices.findOne({_id: device._id, username: device.username},
				function(err, data){
					if (err) {
						res.status(500);
						res.send(err);
					} else {
						data.description = device.description;
						data.capabilities = device.capabilities;
						data.displayCategories = device.displayCategories;
						data.reportState = device.reportState;
						data.attributes = device.attributes
						data.state = device.state;
						data.save(function(err, d){
							res.status(201);
							res.send(d);
						});
						logger.log('debug', "[Devices] Edited device: " + JSON.stringify(data));
						if (enableGoogleHomeSync == true){gHomeSync(req.user._id)}; // Sync changes with Google Home Graph API
					}
				});
		}
});
///////////////////////////////////////////////////////////////////////////
// Device (Delete)
///////////////////////////////////////////////////////////////////////////
router.delete('/device/:dev_id', defaultLimiter,
	ensureAuthenticated,
	function(req,res){
		var user = req.user.username;
		var id = req.params.dev_id;
		if (req.user.username != mqtt_user) {
			Devices.deleteOne({_id: id, username: user},
				function(err) {
					if (err) {
						logger.log('warn', "[Device] Unable to delete device id: " + id + " for user: " + req.user.username, err);
						res.status(500);
						res.send(err);
					} else {
						logger.log('info', "[Device] Deleted device id: " + id + " for user: " + req.user.username);
						res.status(202);
						res.send();
						if (enableGoogleHomeSync == true){gHomeSync(req.user._id)}; // Sync changes with Google Home Graph API
					}
				});
		}
		else if (req.user.username === mqtt_user) {
			Devices.deleteOne({_id: id},
				function(err) {
					if (err) {
						logger.log('warn', "[Admin] Unable to delete device id: " + id, err);
						res.status(500);
						res.send(err);
					} else {
						logger.log('info', "[Admin] Superuser deleted device id: " + id);
						res.status(202);
						res.send();
						if (enableGoogleHomeSync == true){gHomeSync(req.user._id)}; // Sync changes with Google Home Graph API
					}
				});
		}
});
///////////////////////////////////////////////////////////////////////////
// Devices API (Post)
///////////////////////////////////////////////////////////////////////////
router.post('/api/v1/devices', defaultLimiter,
	passport.authenticate('bearer', { session: false }),
	function(req,res,next){
		var devices = req.body;
		if (typeof devices == 'object' && Array.isArray(devices)) {
			for (var i=0; i<devices.lenght; i++) {
				var endpointId = devices[i].endpointId;
				Devices.updateOne({
						username: req.user, 
						endpointId: endpointId
					},
					devices[i],
					{
						upsert: true
					},
					function(err){
						//log error
				});
			}
			if (enableGoogleHomeSync == true){gHomeSync(req.user._id)}; // Sync changes with Google Home Graph API
		} else {
			res.error(400);
		}
	}
);
///////////////////////////////////////////////////////////////////////////
// Functions
///////////////////////////////////////////////////////////////////////////
function ensureAuthenticated(req,res,next) {
    if (req.isAuthenticated()) {
        return next();
    } else {
        //console.log("failed auth?");
        res.redirect('/login');
    }
}

module.exports = router;