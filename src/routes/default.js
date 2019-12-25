///////////////////////////////////////////////////////////////////////////
// Depends
///////////////////////////////////////////////////////////////////////////
var express = require('express');
var router = express.Router();
var bodyParser = require('body-parser');
router.use(bodyParser.urlencoded({ extended: true }));
router.use(bodyParser.json());
const crypto = require('crypto');
var sendemail = require('../services/sendemail');
var mailer = new sendemail();
var Account = require('../models/account');
var oauthModels = require('../models/oauth');
var Devices = require('../models/devices');
var Topics = require('../models/topics');
var LostPassword = require('../models/lostPassword');
var verifyEmail = require('../models/verifyEmail');
var passport = require('passport');
var countries = require('countries-api');
var logger = require('../loaders/logger');
const defaultLimiter = require('../loaders/limiter').defaultLimiter;
const restrictiveLimiter = require('../loaders/limiter').restrictiveLimiter;
///////////////////////////////////////////////////////////////////////////
// Functions
///////////////////////////////////////////////////////////////////////////
const gHomeFunc = require('../services/func-ghome');
const sendState =  gHomeFunc.sendState;
const queryDeviceState = gHomeFunc.queryDeviceState;
const isGhomeUser = gHomeFunc.isGhomeUser;
const requestToken2 = gHomeFunc.requestToken2;
const gHomeSync = gHomeFunc.gHomeSync;
const sendPageView = require('../services/ganalytics').sendPageView;
const sendPageViewUid = require('../services/ganalytics').sendPageViewUid;
const sendEventUid = require('../services/ganalytics').sendEventUid;
///////////////////////////////////////////////////////////////////////////
// Variables
///////////////////////////////////////////////////////////////////////////
//var debug = (process.env.ALEXA_DEBUG || false);
var mqtt_user = (process.env.MQTT_USER);
// Google Home Sync =========================
var enableGoogleHomeSync = true;
// Warn on SYNC_API not being specified/ request SYNC will be disabled
if (!(process.env.HOMEGRAPH_APIKEY)){
	enableGoogleHomeSync = false;
}
///////////////////////////////////////////////////////////////////////////
// Home
///////////////////////////////////////////////////////////////////////////
router.get('/', defaultLimiter, function(req,res){
	sendPageView(req.path, 'Home', req.ip, req.headers['user-agent']);
	// outputSessionID(req, "/");
	res.render('pages/index', {user: req.user, home: true, title: "Home | Node-RED Smart Home Control"});
});
///////////////////////////////////////////////////////////////////////////
// Docs
///////////////////////////////////////////////////////////////////////////
router.get('/docs', defaultLimiter, function(req,res){
	sendPageView(req.path, 'Docs', req.ip, req.headers['user-agent']);
	//outputSessionID(req, "/docs");
	res.render('pages/docs', {user: req.user, docs: true, title: "Docs | Node-RED Smart Home Control"});
});
///////////////////////////////////////////////////////////////////////////
// About
///////////////////////////////////////////////////////////////////////////
router.get('/about', defaultLimiter, function(req,res){
	sendPageView(req.path, 'About', req.ip, req.headers['user-agent']);
	//outputSessionID(req, "/about");
	res.render('pages/about', {user: req.user, about: true, title: "About | Node-RED Smart Home Control"});
});
///////////////////////////////////////////////////////////////////////////
// Privacy
///////////////////////////////////////////////////////////////////////////
router.get('/privacy', defaultLimiter, function(req,res){
	sendPageView(req.path, 'Privacy', req.ip, req.headers['user-agent']);
	//outputSessionID(req, "/privacy");
	res.render('pages/privacy', {user: req.user, privacy: true, title: "Privacy Policy | Node-RED Smart Home Control"});
});
///////////////////////////////////////////////////////////////////////////
// TOS
///////////////////////////////////////////////////////////////////////////
router.get('/tos', defaultLimiter, function(req,res){
	sendPageView(req.path, 'Terms of Service', req.ip, req.headers['user-agent']);
	//outputSessionID(req, "/tos");
	res.render('pages/tos', {user: req.user, tos: true, title: "Terms of Service | Node-RED Smart Home Control"});
});
///////////////////////////////////////////////////////////////////////////
// Login (Get)
///////////////////////////////////////////////////////////////////////////
router.get('/login', defaultLimiter, function(req,res){
	sendPageView(req.path, 'Login', req.ip, req.headers['user-agent']);
	//outputSessionID(req, "/login");
	res.render('pages/login',{user: req.user, login: true, title: "Login | Node-RED Smart Home Control", message: req.flash('error')});
});
///////////////////////////////////////////////////////////////////////////
// Logout
///////////////////////////////////////////////////////////////////////////
router.get('/logout', defaultLimiter, function(req,res){
	sendPageView(req.path, 'Logout', req.ip, req.headers['user-agent']);
	req.logout();
	if (req.query.next) {
		//console.log(req.query.next);
		res.redirect(req.query.next);
	} else {
		res.redirect('/');
	}
	//outputSessionID(req, "/logout");
});

///////////////////////////////////////////////////////////////////////////
// Login (Post) - restrictiveLimiter
///////////////////////////////////////////////////////////////////////////
router.post('/login', defaultLimiter,
	passport.authenticate('local',{ failureRedirect: '/login', failureFlash: true, session: true }),
	function(req,res){
		sendPageViewUid(req.path, 'Login', req.ip, req.user.username, req.headers['user-agent']);
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
	sendPageView(req.path, 'New User', req.ip, req.headers['user-agent']);
	//outputSessionID(req, "/newuser");
    res.render('pages/register',{user: req.user, newuser: true, title: "Register | Node-RED Smart Home Control"});
});
///////////////////////////////////////////////////////////////////////////
// Register/ Newuser (Post) restrictiveLimiter
///////////////////////////////////////////////////////////////////////////
router.post('/newuser', restrictiveLimiter, function(req,res){
    var body = JSON.parse(JSON.stringify(req.body));
    if (body.hasOwnProperty('username') && body.hasOwnProperty('email') && body.hasOwnProperty('country') && body.hasOwnProperty('password')) {
		logger.log('verbose', "[New User] Looking up region for country: " + req.body.country.toUpperCase());
		const pCountry = countries.findByCountryCode(req.body.country.toUpperCase());
		const pUsers = Account.findOne({email: req.body.email});

        Promise.all([pCountry, pUsers]).then(([userCountry, users]) => {
			if (!users && userCountry.statusCode == 200) {
				var region = userCountry.data[0].region;
				// Force new usernames to be lowercase, will also prevent duplicate usernames with case variances
				var username = req.body.username.toLowerCase();
				/// Change this from register to ?create? then move out login so that user has to manually login
                Account.register(new Account({ username : username, email: req.body.email, country: req.body.country.toUpperCase(), region: region,  mqttPass: "foo", active: true }), req.body.password, function(err, account) {
					// On error stop any further processing
					if (err) {
						logger.log('error', "[New User] New user creation error: " + err);
						//res.locals.error_messages = 'Failed to create account!';
						req.flash('error_messages', 'Failed to create account!');
						return res.status(500).send('Failed to create account!');
                        //return res.status(400).send(err.message);
					}
					// No error, so account creation was successful
					logger.log('info', "[New User] Created new user, username: " + username + " email:"  + req.body.email + " country:" +  req.body.country + " region:" + region );
					// Construct MQTT topics for new user
					var topics = new Topics({topics: [
                            'command/' + account.username +'/#',
                            'state/'+ account.username + '/#',
							'response/' + account.username + '/#',
							'message/' + account.username + '/#'
						]});
					// Save MQTT Topics for new user
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
					/////// Trigger Email Validation Workflow
					var mailToken = new verifyEmail({ _userId: account._id, token: crypto.randomBytes(16).toString('hex') });
					// Save the verification token
					mailToken.save(function (err) {
						if (err) {
							logger.log('error' , "[New User] Save user email verification token failed, error: " + err);
							req.flash('error_messages', 'Failed to create email verification token!');
							return res.status(500).send('Failed to create email verification token!');
						}
						// Send Verification Email
						var body = mailer.buildVerifyEmail(mailToken.token, account.username, process.env.WEB_HOSTNAME);
						//var mailSent = mailer.send(account.email, process.env.MAIL_USER, 'Account Verification for Node-RED Smart Home Control', body.text, body.html);
						mailer.send(req.body.email, process.env.MAIL_USER, 'Account Verification for Node-RED Smart Home Control', body.text, body.html, function(returnValue) {
							if (returnValue == true) {
								sendEventUid(req.path, "Security", "Create Account", req.ip, req.body.username, req.headers['user-agent']);
								req.flash('success_messages', 'A verification email has been sent to: ' + req.body.email);
								res.status(200).send('A verification email has been sent to: ' + req.body.email)
							}
							else {
								req.flash('error_messages', 'Verification email failed to send!');
								res.status(500).send('Verification email failed to send!');
							}
						});
					});
                });
			}
			else if (users){
				logger.log('error', "[New User] Cannot create new user, user with email address already exists!");
				req.flash('error_messages', 'Cannot create new user, user with email address already exists!');
				return res.status(500).send('Cannot create new user, user with email address already exists!');
			}
        }).catch(err => {
			logger.log('warn', "[New User] User region lookup failed, error:" + err);
			req.flash('error_messages', 'Account creation failed, please check country is correctly specified!');
            res.status(500).send("Account creation failed, please check country is correctly specified!");
        });
    }
    else {
		logger.log('warn', "[New User] Missing/ incorrect elements supplied for user account creation");
		req.flash('error_messages', 'Missing required attributes, please check registration form!');
        res.status(500).send("Missing required attributes, please check registration form!");
    }
});
///////////////////////////////////////////////////////////////////////////
// Verify GET
///////////////////////////////////////////////////////////////////////////
router.get(['/verify', '/verify/:token'], defaultLimiter, function(req,res){
	sendPageView(req.path, 'Verify', req.ip, req.headers['user-agent']);
	if (req.params.token) {
		res.render('pages/verify', {token: req.params.token, user: req.user, title: "Verify Account | Node-RED Smart Home Control"});
	}
	else {
		req.flash('error_messages', 'No token value supplied in URL, please ensure you manually enter token value below!');
		res.render('pages/verify',{token: undefined, user: req.user, title: "Verify Account | Node-RED Smart Home Control"});
	}
});
///////////////////////////////////////////////////////////////////////////
// Verify Status
///////////////////////////////////////////////////////////////////////////
router.post('/verify', defaultLimiter, function(req,res){
	if (req.body.token && req.body.email) {
		// Find a matching token
		verifyEmail.findOne({ token: req.body.token }, function (err, token) {
			if (!token) {
				req.flash('error_messages', 'We were unable to find a valid token. Your token my have expired!');
				return res.status(400).send('We were unable to find a valid token. Your token my have expired!');
			}
			// If we found a token, find a matching user
			Account.findOne({ _id: token._userId, email: req.body.email }, function (err, account) {
				if (!account) {
					req.flash('error_messages', 'We were unable to find a user for this token!');
					return res.status(400).send('We were unable to find a user for this token!');
				}
				if (account.isVerified) {
					req.flash('error_messages', 'Your account is already verified!');
					return res.status(400).send('Your account is already verified!');
				}

				// Verify and save the user
				account.isVerified = true;
				account.save(function (err) {
					if (err) {
						logger.log('error' , "[Verify] Update user account: " + account.username + " isVerified:true failed, error: " + err);
						req.flash('error_messages', 'Failed to update user account!');
						return res.status(500).send('Failed to update user account!');
					}
					logger.log('verbose' , "[Verify] Update user account: " + account.username + " isVerified:true success");
					req.flash('success_messages', 'The account has been verified, you can now log in!');
					res.status(200).send("The account has been verified, you can now log in!");
				});
			});
		});
	}
	else {
		//logger.log('debug' , "[Verify] Req.body: " + JSON.stringify(req.body));
		if (!req.body.email) {
			req.flash('error_messages', 'Please ensure you fill-in email address!');
			return res.status(400).send('Please ensure you fill-in email address!');
		}
		if (!req.body.token) {
			req.flash('error_messages', 'Please ensure you fill-in token value!');
			return res.status(400).send('Please ensure you fill-in token value!');
		}
	}
});

///////////////////////////////////////////////////////////////////////////
// Verify Resend GET
///////////////////////////////////////////////////////////////////////////
router.get('/verify-resend', defaultLimiter, function(req,res){
	sendPageView(req.path, 'Verify Resend', req.ip, req.headers['user-agent']);
    res.render('pages/verify-resend', {user: req.user, title: "Verify Re-Send | Node-RED Smart Home Control"});
});
///////////////////////////////////////////////////////////////////////////
// Verify Resend POST
///////////////////////////////////////////////////////////////////////////
router.post('/verify-resend', defaultLimiter, function(req,res){
	if (req.body.email) {
		Account.findOne({email: req.body.email}, function(error, account){
			if (!error){
				if (account && (!account.isVerified || account.isVerified && account.isVerified == false)){
					var mailToken = new verifyEmail({ _userId: account._id, token: crypto.randomBytes(16).toString('hex') });
					// Save the verification token
					mailToken.save(function (err) {
						if (err) {
							logger.log('error' , "[Verify Resend] Save user email verification token failed, error: " + err);
							req.flash('error_messages', 'Failed to create email verification token!');
							return res.status(500).send('Failed to create email verification token!');
						}
						// Send Verification Email
						var body = mailer.buildVerifyEmail(mailToken.token, account.username, process.env.WEB_HOSTNAME);
						mailer.send(account.email, process.env.MAIL_USER, 'Account Verification for Node-RED Smart Home Control', body.text, body.html, function(returnValue) {
							if (returnValue == true) {
								sendEventUid(req.path, "Security", "Send re-verification email", req.ip, account.username, req.headers['user-agent']);
								logger.log('info' , "[Verify Resend] A new verification email has been sent to: " + account.email);
								req.flash('success_messages', 'A verification email has been sent to: ' + account.email);
								return res.status(200).send('A verification email has been sent to: ' + account.email);
							}
							else {
								logger.log('error' , "[Verify Resend] Failed to send verification email to: " + account.email);
								req.flash('error_messages', 'Verification email failed to send!');
								return res.status(500).send('Verification email failed to send!');
							}
						});
					});
				}
				else if (account && account.isVerified && account.isVerified == true) {
					req.flash('error_messages', 'Your account is already verified!');
					return res.status(400).send('Your account is already verified!');
				}
				else {
					logger.log('warn' , "[Verify Resend] No user found with supplied email: " + req.body.email);
					req.flash('error_messages', "No user found with that email address, check your account configuration under 'My Account'");
					res.status(400).send("No user found with that email address, check your account configuration under 'My Account'");
				}
			}
			else {
				logger.log('error' , "[Verify Resend] Error looking up user account with supplied email: " + req.body.email);
				req.flash('error_messages', 'Error looking up user account!');
				return res.status(500).send('Error looking up user account!');
			}
		});
	}
	else {
		logger.log('verbose' , "[Verify Resend] Missing email address!");
		req.flash('error_messages', 'Please ensure you fill-in email address!');
		return res.status(400).send('Missing email address!');
	}
});

///////////////////////////////////////////////////////////////////////////
// change-password/:token (Get)
///////////////////////////////////////////////////////////////////////////
router.get(['/change-password', '/change-password/:token'], restrictiveLimiter, function(req, res, next){
	sendPageView(req.path, 'Change Password with Token', req.ip, req.headers['user-agent']);
	if (req.params.token) {
		res.render('pages/change-password', {token: req.params.token, user: req.user, title: "Change Password | Node-RED Smart Home Control"});
	}
	else {
		// Disable flash message if logged in
		if (!req.user) {req.flash('error_messages', 'No token value supplied in URL, please ensure you manually enter token value below!')};
		res.render('pages/change-password',{token: undefined, user: req.user, title: "Change Password | Node-RED Smart Home Control"});
	}
});
///////////////////////////////////////////////////////////////////////////
// change-password (Post) restrictiveLimiter
///////////////////////////////////////////////////////////////////////////
router.post('/change-password', defaultLimiter, function(req, res, next){
	// Authenticated user, accessing via "My Account" page, no token required
	if (req.isAuthenticated()) {
		logger.log('verbose' , "[Change Password] Logged in user request to change password for user account: " + req.user.username);
		// User is already logged-in, reset their password
		resetPassword(req.user.username, req.body.password)
			.then(result => {
				//logger.log('verbose' , "[Change Password] resetPassword result: " + result);
				if (result == true) {
					sendEventUid(req.path, "Security", "Successfully Changed Password", req.ip, req.user.username, req.headers['user-agent']);
					req.flash('success_messages', 'Changed Password!');
					//res.locals.success_messages = 'Changed Password!';
					res.status(200).send();
				}
				else {
					sendEventUid(req.path, "Security", "Failed to Changed Password", req.ip, req.user.username, req.headers['user-agent']);
					req.flash('error_messages', 'Error setting new password!');
					//res.locals.error_messages = 'Error setting new password!';
					res.status(400).send("Problem setting new password");
				}
			})
			.catch(e => {
				//sendEventUid(req.path, "Security", "Failed to Changed Password", req.ip, req.user.username, req.headers['user-agent']);
				req.flash('error_messages', 'Error setting new password!');
				//res.locals.error_messages = 'Error setting new password!';
				res.status(400).send("Problem setting new password");
			})
	}
	else {
		// Un-authenticated user, accessing via /change-password page, token required
		logger.log('verbose' , "[Change Password] Anonymous user request to change password for user account");
		//logger.log('verbose' , "[Change Password] Anonymous user request, body: " + JSON.stringify(req.body));
		if (req.body.token) {
			// Validate a token exists to change password, if it does, and it matches log user in and reset password
			var token = req.body.token;
			LostPassword.findOne({uuid: token}).populate('user').exec(function(error, lostPassword){
				if (!error && lostPassword) {
					req.login(lostPassword.user, function(err){
						if (!err){
							lostPassword.remove();
							resetPassword(req.user.username, req.body.password)
								.then(result => {
									logger.log('verbose' , "[Change Password] resetPassword result: " + result);
									if (result == true) {
										sendEventUid(req.path, "Security", "Successfully Changed Password", req.ip, req.user.username, req.headers['user-agent']);
										req.flash('success_messages', 'Changed Password!');
										//res.locals.success_messages = 'Changed Password!';
										return res.status(200).send();
									}
									else {
										sendEventUid(req.path, "Security", "Failed to Changed Password", req.ip, req.user.username, req.headers['user-agent']);
										req.flash('error_messages', 'Error setting new password!');
										return res.status(400).send("Error setting new password");
									}
								})
								.catch(e => {
									//sendEventUid(req.path, "Security", "Failed to Changed Password", req.ip, req.user.username, req.headers['user-agent']);
									req.flash('error_messages', 'Error setting new password!');
									//res.locals.error_messages = 'Error setting new password!';
									res.status(400).send("Error setting new password");
								})
						}
						else {
							logger.log('error', "[Change Password] Unable to login user to reset password, user: " + lostPassword.user);
							req.flash('error_messages', 'Failed to reset password!');
							//res.locals.error_messages = 'Failed to reset password!';
							return res.status(400).send('Failed to reset password!');
						}
					})
				} else {
					logger.log('warn', "[Change Password] Unable to find matching token for account!");
					req.flash('error_messages', 'Unable to find matching token for your account!');
					//res.locals.error_messages = 'Unable to find matching token for your account!';
					return res.status(400).send('Unable to find matching token for your account!');
				}
			});
		}
		else {
			req.flash('error_messages', 'Please ensure you fill-in token value!');
			//res.locals.error_messages = 'Please ensure you fill-in token value!';
			return res.status(400).send('Please ensure you fill-in token value!');
		}
	}
});

///////////////////////////////////////////////////////////////////////////
// lost-password (Get)
///////////////////////////////////////////////////////////////////////////
router.get('/lost-password', defaultLimiter, function(req, res, next){
	if (req.user){
		sendPageViewUid(req.path, 'Lost Password', req.ip, req.user.username, req.headers['user-agent']);
	}
	else {
		sendPageView(req.path, 'Lost Password', req.ip, req.headers['user-agent']);
	}
	//outputSessionID(req, "/lost-password");
    res.render('pages/lost-password', { user: req.user, title: "Account Recovery | Node-RED Smart Home Control"});
});
///////////////////////////////////////////////////////////////////////////
// lost-password (Post) restrictiveLimiter
///////////////////////////////////////////////////////////////////////////
router.post('/lost-password', defaultLimiter, function(req, res, next){
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
                    var body = mailer.buildLostPasswordBody(lostPassword.uuid, lostPassword.user.username, process.env.WEB_HOSTNAME);
					mailer.send(req.body.email, process.env.MAIL_USER, 'Password Reset for Node-Red-Alexa-Smart-Home-v3', body.text, body.html);
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
		sendPageViewUid(req.path, 'My Account', req.ip, req.user.username, req.headers['user-agent']);
		//outputSessionID(req, "/my-account");
        const pUser = Account.findOne({username: req.user.username});
        Promise.all([pUser]).then(([userAccount]) => {
            //logger.log('info', "userAccount: " + userAccount);
            res.render('pages/account',{user: userAccount, acc: true, title: "My Account | Node-RED Smart Home Control"});
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
		sendPageViewUid(req.path, 'My Devices', req.ip, req.user.username, req.headers['user-agent']);
		//outputSessionID(req, "/devices");
		var user = req.user.username;
		var verified = undefined;
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

		// Capture verification status
		if (!req.user.isVerified || req.user.isVerified == false){
			verified = false;
		}
		else {
			verified = true;
		}

		Promise.all([pUserDevices, pCountDevices, pCountGrants]).then(([devices, countDevs, countUserGrants]) => {
			//logger.log('info', "Grant count for user: " + user + ", grants: " + countUserGrants[0].countGrants);
			//logger.log('info', "countUserGrants: " + JSON.stringify(countUserGrants));
			res.render('pages/devices',{user: req.user, devices: devices, count: countDevs, grants: countUserGrants[0].countGrants, isVerified: verified, fqdn: process.env.WEB_HOSTNAME, devs: true, title: "My Devices | Node-RED Smart Home Control"});
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

// function outputSessionID(req, path) {
// 	if (req.session.id) {
// 		if (req.user) {
// 			logger.log("debug","[Express Session] User: " + req.user.username + ", path: " + path + ", IP address: " + req.ip + ", sessionID: " + req.session.id);
// 		}
// 		else {
// 			logger.log("debug","[Express Session] User path: " + path + ", IP address: " + req.ip + ", sessionID: " + req.session.id);
// 		}
// 	}
// }

// Async function for password reset
const resetPassword = async(username, password) => {
	try {
		// Find User/ Set Password
		var user = await Account.findOne({username: username});
		await user.setPassword(password);
		// Set MQTT Password
		var mqttPass = "PBKDF2$sha256$901$" + user.salt + "$" + user.hash;
		user.mqttPass = mqttPass;
		// Save Account
		await user.save();
		// Return Success
		logger.log('verbose', "[Change Password] Changed password for: " + user.username);
		return true;

	}
	catch(e) {
		logger.log('error', "[Change Password] Unable to change password for user, error: " + e);
		return false;
	}

	// Account.findOne({username: username})
	// 	.then(user => {
	// 		if (user) {
	// 			user.setPassword(password, function(e,u){
	// 				//var s = Buffer.from(user.salt, 'hex').toString('base64');
	// 				//var h = Buffer.from(user.hash, 'hex').toString(('base64'));
	// 				var mqttPass = "PBKDF2$sha256$901$" + user.salt + "$" + user.hash;
	// 				u.mqttPass = mqttPass;
	// 				u.save(function(error){
	// 					if (!error) {
	// 						logger.log('verbose', "[Change Password] Changed password for: " + u.username);
	// 						return true;

	// 					} else {
	// 						logger.log('warn', "[Change Password] Unable to change password for: " + u.username);
	// 						logger.log('debug', "[Change Password] " + error);
	// 						return false;
	// 					}
	// 				});
	// 			});
	// 		}
	// 		else {
	// 			logger.log('warn', "[Change Password] Unable to change password for user, user not found: " + username);
	// 			logger.log('debug', "[Change Password] " + err);
	// 			return false;
	// 		}
	// 	})
	// 	.catch(err => {
	// 		logger.log('error', "[Change Password] Unable to lookup user, error: " + err);
	// 		return false;
	// 	});

}

module.exports = router;