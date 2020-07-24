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
var alexaAuthModels = require('../models/alexa-auth');
var Devices = require('../models/devices');
var Topics = require('../models/topics');
var LostPassword = require('../models/lostPassword');
var verifyEmail = require('../models/verifyEmail');
var passport = require('passport');
var countries = require('countries-api');
var logger = require('../loaders/logger');
const defaultLimiter = require('../loaders/limiter').defaultLimiter;
const restrictiveLimiter = require('../loaders/limiter').restrictiveLimiter;
const removeUserServices = require('../services/func-services').removeUserServices;
///////////////////////////////////////////////////////////////////////////
// Functions
///////////////////////////////////////////////////////////////////////////
const gHomeFunc = require('../services/func-ghome');
const gHomeSync = gHomeFunc.gHomeSyncAsync;
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
// Regular Expressions, used for validating API POST requests
let passwordRegExp = /(?=^.{12,}$)((?=.*\d)|(?=.*\W+))(?![.\n])(?=.*[A-Z])(?=.*[a-z]).*$/;
let emailRegExp = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
let usernameRegExp = /^[a-z0-9]{5,15}$/;
///////////////////////////////////////////////////////////////////////////
// Home
///////////////////////////////////////////////////////////////////////////
router.get('/', defaultLimiter, async (req, res) => {
	sendPageView(req.path, 'Home', req.ip, req.headers['user-agent']);
	// outputSessionID(req, "/");
	res.render('pages/index', {user: req.user, home: true, brand: process.env.BRAND, title: "Home | " + process.env.BRAND});
});
///////////////////////////////////////////////////////////////////////////
// Docs
///////////////////////////////////////////////////////////////////////////
router.get('/docs', defaultLimiter, async (req, res) => {
	sendPageView(req.path, 'Documentation', req.ip, req.headers['user-agent']);
	//outputSessionID(req, "/docs");
	//res.render('pages/docs', {user: req.user, docs: true, brand: process.env.BRAND, title: "Documentation | " + process.env.BRAND});
	res.status(301).redirect('https://docs.cb-net.co.uk');
});
///////////////////////////////////////////////////////////////////////////
// About
///////////////////////////////////////////////////////////////////////////
router.get('/about', defaultLimiter, async (req, res) => {
	sendPageView(req.path, 'About', req.ip, req.headers['user-agent']);
	//outputSessionID(req, "/about");
	res.render('pages/about', {user: req.user, about: true, brand: process.env.BRAND, title: "About | " + process.env.BRAND});
});
///////////////////////////////////////////////////////////////////////////
// Privacy
///////////////////////////////////////////////////////////////////////////
router.get('/privacy', defaultLimiter, async (req, res) => {
	sendPageView(req.path, 'Privacy', req.ip, req.headers['user-agent']);
	//outputSessionID(req, "/privacy");
	res.render('pages/privacy', {user: req.user, privacy: true, brand: process.env.BRAND, title: "Privacy Policy | " + process.env.BRAND, fqdn: process.env.WEB_HOSTNAME});
});
///////////////////////////////////////////////////////////////////////////
// TOS
///////////////////////////////////////////////////////////////////////////
router.get('/tos', defaultLimiter, async (req, res) => {
	sendPageView(req.path, 'Terms of Service', req.ip, req.headers['user-agent']);
	//outputSessionID(req, "/tos");
	res.render('pages/tos', {user: req.user, tos: true, brand: process.env.BRAND, title: "Terms of Service | " + process.env.BRAND, fqdn: process.env.WEB_HOSTNAME});
});
///////////////////////////////////////////////////////////////////////////
// Login (Get)
///////////////////////////////////////////////////////////////////////////
router.get('/login', defaultLimiter, async (req, res) => {
	sendPageView(req.path, 'Login', req.ip, req.headers['user-agent']);
	//outputSessionID(req, "/login");
	res.render('pages/login',{user: req.user, login: true, brand: process.env.BRAND, title: "Login | " + process.env.BRAND, fqdn: process.env.WEB_HOSTNAME, message: req.flash('error')});
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
router.get('/new-user', defaultLimiter, async (req, res) => {
	sendPageView(req.path, 'New User', req.ip, req.headers['user-agent']);
	//outputSessionID(req, "/new-user");
    res.render('pages/register',{user: req.user, newuser: true, brand: process.env.BRAND, title: "Register | " + process.env.BRAND, fqdn: process.env.WEB_HOSTNAME});
});
///////////////////////////////////////////////////////////////////////////
// Register/ Newuser (Post) restrictiveLimiter
///////////////////////////////////////////////////////////////////////////
router.post('/new-user', restrictiveLimiter, async (req, res) => {
	try {
		var body = JSON.parse(JSON.stringify(req.body));
		if (body.hasOwnProperty('username') && body.hasOwnProperty('email') && body.hasOwnProperty('country') && body.hasOwnProperty('password')) {
			// Check password meets complexity requirements (for programmatic consumers)
			if (passwordRegExp.test(req.body.password) == false) return res.status(400).send('Password does not meet complexity requirements!');
			// Check email address format (for programmatic consumers)
			if (emailRegExp.test(req.body.email) == false) return res.status(400).send('Email address format incorrect!');
			// Check username format (for programmatic consumers)
			if (usernameRegExp.test(req.body.username) == false) return res.status(400).send('Username format incorrect!');
			// Get country from user supplied entry
			var userCountry = await countries.findByCountryCode(req.body.country.toUpperCase());
			// Check for any account that match given email address
			var users = await Account.findOne({email: req.body.email});
			// If no matching users and we have country information proceed to create account
			if (!users && userCountry.statusCode == 200) {
				// Lookup region from userCountry, used to route Alexa state reports
				var region = userCountry.data[0].region;
				// Force new usernames to be lowercase, will also prevent duplicate usernames with case variances
				var username = req.body.username.toLowerCase();
				// Generate random, temporary MQTT password
				var mqttPass = crypto.randomBytes(16).toString('hex');
				// Register new user, Passport will verify username is unique, MQTT password set to random in case of later failures
				var account = await Account.register(new Account({ username : username, email: req.body.email, country: req.body.country.toUpperCase(), region: region,  password: mqttPass, mqttPass: mqttPass, active: true }), req.body.password);
				//Generate Mail Verification Token
				var mailToken = new verifyEmail({ user: account, token: crypto.randomBytes(16).toString('hex') });
				// Save Mail Verification Token
				await mailToken.save();
				// Generate Verification Email
				var body = mailer.buildVerifyEmail(mailToken.token, account.username, process.env.WEB_HOSTNAME);
				// Send  Verification Email
				mailer.send(req.body.email, process.env.MAIL_USER, 'Account Verification for ' + process.env.BRAND, body.text, body.html, function(returnValue) {
					// Success, 201 Created
					if (returnValue == true) {
						sendEventUid(req.path, "Security", "Create Account", req.ip, req.body.username, req.headers['user-agent']);
						res.status(201).send('A verification email has been sent to: ' + req.body.email + ", you need to verify your account to use this service.")
					}
					// Failed, 500 Internal Service Error
					else {
						res.status(500).send('Verification email failed to send!');
					}
				});
			}
			else {
				// User exists with this email address, 409 Conflict
				if (users) {
					logger.log('error', "[New User] Cannot create new user, user with email address already exists!");
					return res.status(409).send('User with this email address already exists!');
				}
				// Error occurred with userCountry, 500 Internal Service Error
				else {
					logger.log('error', "[New User] Creation failed, country status code: " + userCountry.statusCode);
					return res.status(500).send('New user creation failed!');
				}
			}
		}
		else {
			// Missing critical body elements, 400 Bad Request
			return res.status(400).send('Please complete all required fields!');
		}
	}
	catch (e) {
		// General failure, 500 Internal Service Error
		logger.log('error', "[New User] Cannot create new user, error: " + e.stack);
		return res.status(500).send('New user creation failed!');
	}
});
///////////////////////////////////////////////////////////////////////////
// Verify GET
///////////////////////////////////////////////////////////////////////////
router.get(['/verify', '/verify/:token'], defaultLimiter, async (req, res) => {
	sendPageView(req.path, 'Verify', req.ip, req.headers['user-agent']);
	let message = undefined;
	if (!req.params.token) {
		message = 'No token value supplied in URL, please ensure you manually enter token value below!';
		res.render('pages/verify',{token: undefined, user: req.user, brand: process.env.BRAND, title: "Verify Account | " + process.env.BRAND, message: message});
	}
	else {
		res.render('pages/verify',{token: req.params.token, user: req.user, brand: process.env.BRAND, title: "Verify Account | " + process.env.BRAND, message: message});
	}
});
///////////////////////////////////////////////////////////////////////////
// Verify Status
///////////////////////////////////////////////////////////////////////////
router.post('/verify', defaultLimiter, async (req, res) => {
	try {
		if (req.body.token) {
			// Find a matching token, populate user for use in findByUsername account lookup
			var token = await verifyEmail.findOne({ token: req.body.token }).populate('user').exec();
			// If no token return 400, bad request
			if (!token) return res.status(400).send('Unable to find matching token!');
			// Find related user, returning hash/ salt
			var account = await Account.findByUsername(token.user.username, true);
			// Check account is not already verified (no need to proceed if it is)
			if (!account) {
				return res.status(400).send('Unable to find account associated with token!');
			}
			else if (account.isVerified) {
				return res.status(400).send('Your account is already verified!');
			}
			if (account) logger.log('debug', "[Verify] account hash: " + account.hash + ", account salt: " + account.salt);
			// Find pattern-based ACL
			// var aclPattern = await Topics.findOne({topics:	['command/%u/#','state/%u/#','response/%u/#','message/%u/#']});
			// Check for existing ACL
			var aclUser = await Topics.findOne({topics: [
				'command/' + account.username +'/#',
				'state/'+ account.username + '/#',
				'response/' + account.username + '/#',
				'message/' + account.username + '/#'
			]});
			// If does not exist, create user-specific ACL
			if (!aclUser) {
				var aclUser = new Topics({topics: [
					'command/' + account.username +'/#',
					'state/'+ account.username + '/#',
					'response/' + account.username + '/#',
					'message/' + account.username + '/#'
				]});
				// Save new user-specific MQTT topics
				await aclUser.save();
			}
			// Create MQTT password based upon returned salt and hash
			var mqttPass = "PBKDF2$sha256$901$" + account.salt + "$" + account.hash;
			// Update the user account with MQTT password and MQTT topics, set isVerified to true
			await Account.updateOne({username: account.username},{$set: {password: mqttPass, mqttPass: mqttPass, topics: aclUser._id, isVerified: true}});
			// Log success
			logger.log('verbose' , "[Verify] Update user account: " + account.username + " isVerified success");
			logger.log('verbose' , "[Verify] Update user account: " + account.username + " topics: " + JSON.stringify(aclUser));
			// Send 200 response
			return res.status(202).send("The account has been verified, you can now use the service!");
		}
		else {
			// Token not supplied, send 400 status
			if (!req.body.token) {
				return res.status(400).send('Please ensure you fill-in token value!');
			}
		}
	}
	catch(e) {
		// General error, send 500 status
		logger.log('error' , "[Verify] Update user account error: " + e.stack);
		return res.status(500).send('Failed to update user account!');
	}
});

///////////////////////////////////////////////////////////////////////////
// Verify Resend GET
///////////////////////////////////////////////////////////////////////////
router.get('/verify-resend', defaultLimiter, async (req, res) => {
	sendPageView(req.path, 'Verify Resend', req.ip, req.headers['user-agent']);
    res.render('pages/verify-resend', {user: req.user, brand: process.env.BRAND, title: "Verify Re-Send | " + process.env.BRAND});
});
///////////////////////////////////////////////////////////////////////////
// Verify Resend POST
///////////////////////////////////////////////////////////////////////////
router.post('/verify-resend', defaultLimiter,  async (req, res) => {
	try {
		if (req.body.email) {
			// Find related user
			var account = await Account.findOne({email: req.body.email});
			// Check account is not already verified
			if (!account) {
				return res.status(400).send('Unable to find matching account, check supplied email address!');
			}
			if (!account.isVerified || account.isVerified && account.isVerified == false){
				// generate new Verification Token
				var mailToken = new verifyEmail({ user: account, token: crypto.randomBytes(16).toString('hex') });
				// Save the verification token
				await mailToken.save();
				// Generate Verification Email
				var body = mailer.buildVerifyEmail(mailToken.token, account.username, process.env.WEB_HOSTNAME);
				// Send Verification Email
				mailer.send(account.email, process.env.MAIL_USER, 'Account Verification for ' + process.env.BRAND, body.text, body.html, function(returnValue) {
					if (returnValue == true) {
						sendEventUid(req.path, "Security", "Send re-verification email", req.ip, account.username, req.headers['user-agent']);
						logger.log('info' , "[Verify Resend] A new verification email has been sent to: " + account.email);
						return res.status(202).send('A verification email has been sent to: ' + account.email);
					}
					else {
						logger.log('error' , "[Verify Resend] Failed to send verification email to: " + account.email);
						return res.status(500).send('Verification email failed to send!');
					}
				});
			}
			// Account already verified
			else if (account && account.isVerified && account.isVerified == true) {
				return res.status(400).send('Your account is already verified!');
			}
		}
		// Missing req.body.email
		else {
			logger.log('verbose' , "[Verify Resend] Missing email address!");
			return res.status(400).send('Missing email address!');
		}
	}
	catch(e){
		// General error, send 500 status
		logger.log('error' , "[Verify Resend] Save user email verification token failed, error: " + e.stack);
		return res.status(500).send('Failed to generate and send email verification token!');
	}
});

///////////////////////////////////////////////////////////////////////////
// change-password/:token (Get)
///////////////////////////////////////////////////////////////////////////
router.get(['/change-password', '/change-password/:token'], restrictiveLimiter, async (req, res) => {
	sendPageView(req.path, 'Change Password with Token', req.ip, req.headers['user-agent']);
	let message = undefined;
	if (!req.params.token && !req.user) {
		message = 'No token value supplied in URL, please ensure you manually enter token value below!';
		res.render('pages/change-password',{token: undefined, user: req.user, brand: process.env.BRAND, title: "Change Password | " + process.env.BRAND, message: message})
	}
	else {
		res.render('pages/change-password',{token: req.params.token, user: req.user, brand: process.env.BRAND, title: "Change Password | " + process.env.BRAND, message: message})
	}
});
///////////////////////////////////////////////////////////////////////////
// change-password (Post) restrictiveLimiter
///////////////////////////////////////////////////////////////////////////
router.post('/change-password', defaultLimiter, async (req, res) => {
	// Authenticated user, accessing via "My Account" page, no token required
	if (req.isAuthenticated()) {
		try {
			logger.log('verbose' , "[Change Password] Logged in user request to change password for user account: " + req.user.username);
			// Check password meets complexity requirements (for programmatic consumers)
			if (passwordRegExp.test(req.body.password) == false) return res.status(400).send('Password does not meet complexity requirements!');
			var result = await resetPassword(req.user.username, req.body.password);
			//  Success, send 202 status
			if (result == true) {
				sendEventUid(req.path, "Security", "Successfully Changed Password", req.ip, req.user.username, req.headers['user-agent']);
				res.status(202).send('Changed Password!');
			}
			//  Failure, send status 500, Internal Service Error
			else {
				sendEventUid(req.path, "Security", "Failed to Changed Password", req.ip, req.user.username, req.headers['user-agent']);
				res.status(500).send("Problem setting new password");
			}
		}
		catch(e) {
			// General error, send 500 status
			logger.log('error' , "[Change Password] Error setting authenticated user's password, error: " + e.stack);
			res.status(500).send("Error setting new password!");
		}

	}
	// Un-authenticated user, accessing via /change-password page, token required
	else {
		try{
			logger.log('verbose' , "[Change Password] Anonymous user request to change password for user account");
			//logger.log('verbose' , "[Change Password] Anonymous user request, body: " + JSON.stringify(req.body));
			if (req.body.token) {
				// Validate a token exists to change password, if it does, and it matches log user in and reset password
				var token = req.body.token;
				var lostPassword = await LostPassword.findOne({uuid: token}).populate('user').exec();
				if (lostPassword) {
					// Check password meets complexity requirements (for programmatic consumers)
					if (passwordRegExp.test(req.body.password) == false) return res.status(400).send('Password does not meet complexity requirements!');
					// Remove one-time use token
					lostPassword.remove();
					// Reset user password
					var result = await resetPassword(lostPassword.user.username, req.body.password);
					logger.log('verbose' , "[Change Password] resetPassword result: " + result);
					if (result == true) {
						sendEventUid(req.path, "Security", "Successfully Changed Password", req.ip, lostPassword.user.username, req.headers['user-agent']);
						return res.status(202).send('Changed Password!');
					}
					else {
						sendEventUid(req.path, "Security", "Failed to Changed Password", req.ip, lostPassword.user.username, req.headers['user-agent']);
						return res.status(500).send("Error setting new password");
					}
				}
			}
			else {
				return res.status(400).send('Please ensure you fill-in token value!');
			}
		}
		catch(e) {
			// General error, send 500 status
			logger.log('error' , "[Change Password] Error setting unauthenticated user's password, error: " + e.stack);
			//sendEventUid(req.path, "Security", "Failed to Changed Password", req.ip, req.user.username, req.headers['user-agent']);
			res.status(500).send("Error setting new password");
		}
	}
});

///////////////////////////////////////////////////////////////////////////
// lost-password (Get)
///////////////////////////////////////////////////////////////////////////
router.get('/lost-password', defaultLimiter, async (req, res) => {
	if (req.user){
		sendPageViewUid(req.path, 'Lost Password', req.ip, req.user.username, req.headers['user-agent']);
	}
	else {
		sendPageView(req.path, 'Lost Password', req.ip, req.headers['user-agent']);
	}
	//outputSessionID(req, "/lost-password");
    res.render('pages/lost-password', { user: req.user, brand: process.env.BRAND, title: "Account Recovery | " + process.env.BRAND});
});
///////////////////////////////////////////////////////////////////////////
// lost-password (Post) restrictiveLimiter
///////////////////////////////////////////////////////////////////////////
router.post('/lost-password', defaultLimiter, async (req, res) => {
	try {
		var email = req.body.email;
		var user = await Account.findOne({email: email});
		if (!user) return res.status(400).send('Unable to find user with supplied email address!');
		var lostPassword = new LostPassword({user: user});
		await lostPassword.save();
		var body = mailer.buildLostPasswordBody(lostPassword.uuid, user.username, process.env.WEB_HOSTNAME);
		mailer.send(req.body.email, process.env.MAIL_USER, 'Password Reset for ' + process.env.BRAND, body.text, body.html, function(returnValue) {
			// Success, 202 Accepted
			if (returnValue == true) {
				res.status(202).send('A password reset email has been sent to: ' + req.body.email + ".")
			}
			// Failed, 500 Internal Service Error
			else {
				res.status(500).send('Password reset email failed to send!');
			}
		});
	}
	catch(e){
		// General error, send 500 status
		logger.log('error' , "[Lost Password] Error generating lost password token/ email, error: " + e.stack);
		res.status(500).send('Error generating lost password token/ email');
	}
});
///////////////////////////////////////////////////////////////////////////
// My-Account
///////////////////////////////////////////////////////////////////////////
router.get('/my-account', defaultLimiter,
    ensureAuthenticated,
    async (req, res) => {
		try {
			sendPageViewUid(req.path, 'My Account', req.ip, req.user.username, req.headers['user-agent']);
			//outputSessionID(req, "/my-account");
			var user = await Account.findOne({username: req.user.username});
			res.render('pages/account',{user: user, acc: true, brand: process.env.BRAND, title: "My Account | " + process.env.BRAND});
		}
		catch(e) {
			// General error, send 500 status
			logger.log('error' , "[My Account] Error rendering My Account, error: " + e.stack);
			res.status(500).send('Failed to render page!');
		}
});
///////////////////////////////////////////////////////////////////////////
// Devices (Get)
///////////////////////////////////////////////////////////////////////////
router.get('/devices', defaultLimiter,
	ensureAuthenticated,
	async (req, res) => {
	try {
		sendPageViewUid(req.path, 'My Devices', req.ip, req.user.username, req.headers['user-agent']);
		var user = req.user.username;
		// Find user devices
		var devices = await Devices.find({username:user});
		// Get Count of Devices
		var countDevs = await Devices.countDocuments({username:user});
		// Get Count of Grant Codes (to show if account is linked or not)
		var countUserGrants = await Account.aggregate([
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
		var verified = undefined;
		if (!req.user.isVerified || req.user.isVerified == false){verified = false}
		else {verified = true}
		// Render Device page
		res.render('pages/devices',{user: req.user, devices: devices, count: countDevs, grants: countUserGrants[0].countGrants, isVerified: verified, fqdn: process.env.WEB_HOSTNAME, devs: true, brand: process.env.BRAND, title: "My Devices | " + process.env.BRAND});
	}
	catch(e){
		// General error, send 500 status
		logger.log('error' , "[Devices] Error rendering user Devices, error: " + e.stack);
		res.status(500).send('Failed to render page!');
	}
});
///////////////////////////////////////////////////////////////////////////
// Devices (Put)
///////////////////////////////////////////////////////////////////////////
router.put('/devices', defaultLimiter,
	ensureAuthenticated,
	async (req, res) => {
		try {
			// Get PUT data
			var user = req.user.username;
			var device = req.body;
			// Set username on device to match req.user.username
			device.username = user;

			// Check for duplicate device name
			var checkDevice = await Devices.findOne({username:user, friendlyName: device.friendlyName});
			if (checkDevice) {
				logger.log('warn' , "[Create Device] User tried to create a device with duplicate friendly name");
				return res.status(500).send('Please ensure your devices have unique names!');
			}
			// Require 2FA PIN on Google Home-enabled user Smart Lock
			if (req.user.activeServices.indexOf('Google') > -1 && device.displayCategories == 'SMARTLOCK' && (!device.attributes.require2FA || !device.attributes.pin || !device.attributes.type2FA)){
				logger.log('warn' , "[Create Device] Google Home user tried to create new Smart Lock device without a PIN");
				return res.status(500).send('As a Google Home user you must set a PIN on your lock!');
			}

			// Create new device
			var dev = new Devices(device);
			// Save device
			await dev.save();
			// Success, send 201 status
			res.status(201).send(dev);
			logger.log('debug', "[Devices] New device created: " + JSON.stringify(dev));
			if (enableGoogleHomeSync == true){gHomeSync(req.user._id)}; // Sync changes with Google Home Graph API
		}
		catch (e){
			// General error, send 500 status
			logger.log('error' , "[Create Device] Error creating new device, error: " + e.stack);
			res.status(500).send('Failed to create device!');
		}
});
///////////////////////////////////////////////////////////////////////////
// account/:user_id (Put)
///////////////////////////////////////////////////////////////////////////
router.post('/account/:user_id', defaultLimiter,
	ensureAuthenticated,
	async (req, res) => {
		try {
			// Get POST data
			var user = req.body;
			// Check requesting user matches req.params.user_id, or that user is SU
			if (req.user.superuser === true || req.user.username == user.username) {
				const userCountry = await countries.findByCountryCode(user.country.toUpperCase());
				var region = userCountry.data[0].region;
				var account = await Account.findOne({_id: req.params.user_id});
				if (req.user.superuser === true) {
					logger.log('info', "[Update User] Superuser updated user account: " + req.params.user_id);
				}
				else {
					logger.log('info', "[Update User] Self-service user account update: " + req.params.user_id);
				}
				account.email = user.email;
				account.country = user.country.toUpperCase();
				account.region = region;
				await account.save();
				res.status(201).send(account);
			}
			else {
				// Access denied, send 401 status
				res.status(401).send();
			}
		}
		catch(e){
			logger.log('warn', "[Update User] Error on updating account, error: " + e.stack);
			res.status(500).send("Unable to update user account!");
		}
});
///////////////////////////////////////////////////////////////////////////
// Account (Delete)
///////////////////////////////////////////////////////////////////////////
router.delete('/account/:user_id', defaultLimiter,
	ensureAuthenticated,
	async (req, res) => {
		try {
			var userId = req.params.user_id;
			// Find user based on req.params.user_id
			var userAccount = await Account.findOne({_id: userId});
			// Check requesting user matches req.params.user_id, or that user is SU
			if (userAccount.username == req.user.username || req.user.superuser === true) {
				var username = userAccount.username;
				// Delete all account data
				await Account.deleteOne({_id: userId});
				await oauthModels.GrantCode.deleteMany({user: userId});
				await oauthModels.AccessToken.deleteMany({user: userId});
				await oauthModels.RefreshToken.deleteMany({user: userId});
				await Devices.deleteMany({username: userAccount.username});
				await Topics.deleteOne({_id:userAccount.topics});
				// Success send 200 status
				res.status(202).send('Account deleted"');
				if (req.user.superuser === true) {
					logger.log('info', "[Delete User] Superuser deleted user account: " + username)
				}
				else {
					logger.log('info', "[Delete User] Self-service account deletion, user account: " + username)
				}
			}
			else {
				// Access denied, send 401 status
				res.status(401).send('Unauthorized');
			}
		}
		catch(e){
			// General error, send 500 status
			logger.log('warn', "[Delete User] Error on deleting account, error: " + e.stack);
			res.status(500).send();
		}
});
///////////////////////////////////////////////////////////////////////////
// Tokens (Delete)
///////////////////////////////////////////////////////////////////////////
router.delete('/tokens/:user_id', defaultLimiter,
ensureAuthenticated,
async (req, res) => {
	try {
		var userId = req.params.user_id;
		// Find user based on req.params.user_id
		var userAccount = await Account.findOne({_id: userId});
		// Check requesting user matches req.params.user_id, or that user is SU
		if (userAccount.username == req.user.username || req.user.superuser === true) {
			var username = userAccount.username;
			// Delete Service Oauth Token data
			await oauthModels.GrantCode.deleteMany({user: userId});
			await oauthModels.AccessToken.deleteMany({user: userId});
			await oauthModels.RefreshToken.deleteMany({user: userId});
			// Delete Alexa Auth Token Data
			await alexaAuthModels.AlexaAuthGrantCode.deleteMany({user: userId});
			await alexaAuthModels.AlexaAuthAccessToken.deleteMany({user: userId});
			await alexaAuthModels.AlexaAuthRefreshToken.deleteMany({user: userId});
			// Remove active services
			removeUserServices(userAccount.username, "Amazon");
			removeUserServices(userAccount.username, "Google");
			// Success send 200 status
			res.status(202).json({message: 'deleted OAuth tokens'});
			if (req.user.superuser === true) {
				logger.log('info', "[Delete Tokens] Superuser deleted OAuth tokens for account: " + username)
			}
			else {
				logger.log('info', "[Delete Tokens] Self-service OAuth token deletion for account: " + username)
			}
		}
		else {
			// Access denied, send 401 status
			res.status(401).send();
		}
	}
	catch(e){
		// General error, send 500 status
		logger.log('warn', "[Delete Tokens] Error on deleting tokens, error: " + e.stack);
		res.status(500).send();
	}
});
///////////////////////////////////////////////////////////////////////////
// Device (Post)
///////////////////////////////////////////////////////////////////////////
router.post('/device/:dev_id', defaultLimiter,
	ensureAuthenticated,
	async (req, res) => {
		try {
			// Read data from POST
			var device = req.body;
			if (req.user.username === device.username) {
				// Find related device in MongoDB
				var data = await Devices.findOne({_id: device._id, username: device.username});
				// Update elements based upon user submission
				data.description = device.description;
				data.capabilities = device.capabilities;
				data.displayCategories = device.displayCategories;
				data.reportState = device.reportState;
				data.attributes = device.attributes;
				data.state = device.state;

				// Require 2FA PIN on Google Home-enabled user Smart Lock
				if (req.user.activeServices.indexOf('Google') > -1 && device.displayCategories == 'SMARTLOCK' && (!device.attributes.require2FA || !device.attributes.pin || !device.attributes.type2FA)){
					logger.log('warn' , "[Create Device] Google Home user tried to create new Smart Lock device without a PIN");
					return res.status(500).send('As a Google Home user you must set a PIN on your lock!');
				}

				// Save updated device
				await data.save();
				// Return 201 status
				res.status(201).send(data);
				logger.log('debug', "[Update Device] Updated device for user: " + req.user.username + ", device: " + JSON.stringify(data));
				// Sync changes with Google Home Graph API
				if (enableGoogleHomeSync == true){gHomeSync(req.user._id)};
			}
			else {
				// Access denied, send 401 status
				res.status(401).send();
			}
		}
		catch(e){
			// General error, send 500 status
			logger.log('warn', "[Update Device] Error on updating device, error: " + e.stack);
			res.status(500).send();
		}
});
///////////////////////////////////////////////////////////////////////////
// Device (Delete)
///////////////////////////////////////////////////////////////////////////
router.delete('/device/:dev_id', defaultLimiter,
	ensureAuthenticated,
	async (req, res) => {
		try{
			var user = req.user.username;
			var id = req.params.dev_id;
			// Route for non-SU user, allow user to delete their own devices
			if (req.user.superuser !== true) {
				// Delete device, using req.user.username and _id
				await Devices.deleteOne({_id: id, username: user});
				res.status(202).send();
				// Sync changes with Google Home Graph API
				if (enableGoogleHomeSync == true){gHomeSync(req.user._id)};
			}
			// User is SU, can delete any device
			else if  (req.user.superuser === true) {
				// Delete device, using _id only, SU limited
				await Devices.deleteOne({_id: id});
				res.status(202).send();
				// Sync changes with Google Home Graph API, need to get user._id to do this
				// if (enableGoogleHomeSync == true){gHomeSync(req.user._id)};
			}
		}
		catch(e){
			// General error, send 500 status
			logger.log('warn', "[Delete Device] Error on deleting device, error: " + e.stack);
			res.status(500).send();
		}
});
///////////////////////////////////////////////////////////////////////////
// Devices API (Post)
///////////////////////////////////////////////////////////////////////////
router.post('/api/v1/devices', defaultLimiter,
	passport.authenticate('bearer', { session: false }),
	async (req, res) => {
		var devices = req.body;
		if (typeof devices == 'object' && Array.isArray(devices)) {
			for (var i=0; i<devices.length; i++) {
				var endpointId = devices[i].endpointId;
				await Devices.updateOne({username: req.user,endpointId: endpointId},devices[i],{upsert: true})
			}
			res.status(202).send();
			if (enableGoogleHomeSync == true){gHomeSync(req.user._id)}; // Sync changes with Google Home Graph API
		} else {
			res.status(500).send();
		}
	}
);
///////////////////////////////////////////////////////////////////////////
// Set State API (Not in Use)
///////////////////////////////////////////////////////////////////////////
// router.post('/setstate/:dev_id',
// 	passport.authenticate(['bearer', 'basic'], { session: false }),
// 	async (req, res) => {
// 		// do nothing, disused for now, may use along side command API
// 	}
// );
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

// Async function for password reset
const resetPassword = async(username, password) => {
	try {
		// Find related user
		var account = await Account.findOne({username: username});
		// Set password
		await account.setPassword(password);
		// Save Account
		await account.save();
		// Get updated user object, returning hash/ salt for use in PBKDF2 MQTT password
		var account = await Account.findByUsername(username, true);
		logger.log('debug', "[Change Password] Account hash: " + account.hash + ", account salt: " + account.salt);
		if (!account.salt || account.salt == undefined || !account.hash || account.hash == undefined){
			logger.log('error', "[Change Password] Unable to set MQTT password, hash / salt unavailable!");
			return false;
		}
		// Set MQTT Password
		var mqttPass = "PBKDF2$sha256$901$" + account.salt + "$" + account.hash;
		account.mqttPass = mqttPass;
		account.password = mqttPass;
		// Save Account
		await account.save();
		// Return Success
		logger.log('verbose', "[Change Password] Changed password for: " + account.username);
		return true;
	}
	catch(e) {
		logger.log('error', "[Change Password] Unable to change password for user, error: " + e);
		return false;
	}
}

module.exports = router;