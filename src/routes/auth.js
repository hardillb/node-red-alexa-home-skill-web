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
var passport = require('passport');
// var BasicStrategy = require('passport-http').BasicStrategy;
// var LocalStrategy = require('passport-local').Strategy;
// var PassportOAuthBearer = require('passport-http-bearer');
var oauthServer = require('../services/oauth');
var url = require('url');
var logger = require('../loaders/logger');
///////////////////////////////////////////////////////////////////////////
// Variables
///////////////////////////////////////////////////////////////////////////
//var debug = (process.env.ALEXA_DEBUG || false);
///////////////////////////////////////////////////////////////////////////
// Passport Configuration
///////////////////////////////////////////////////////////////////////////
// passport.use(new LocalStrategy(Account.authenticate()));
// passport.use(new BasicStrategy(Account.authenticate()));
// passport.serializeUser(Account.serializeUser());
// passport.deserializeUser(Account.deserializeUser());
// var accessTokenStrategy = new PassportOAuthBearer(function(token, done) {
// 	oauthModels.AccessToken.findOne({ token: token }).populate('user').populate('grant').exec(function(error, token) {
// 		if (!error && token && !token.grant) {
// 			logger.log('error', "[Core] Auth Missing grant token:" + token);
// 		}
// 		if (!error && token && token.active && token.grant && token.grant.active && token.user) {
// 			logger.log('debug', "[Core] Auth OAuth Token good, token:" + token);
// 			done(null, token.user, { scope: token.scope });
// 		} else if (!error) {
// 			logger.log('error', "[Core] Auth OAuth Token error, token:" + token);
// 			done(null, false);
// 		} else {
// 			logger.log('error', "[Core] Auth OAuth Token error:" + error);
// 			done(error);
// 		}
// 	});
// });
// passport.use(accessTokenStrategy);
///////////////////////////////////////////////////////////////////////////
// Authorization URI
///////////////////////////////////////////////////////////////////////////
router.get('/start',oauthServer.authorize(function(applicationID, redirectURI, done) {
	if (typeof applicationID == "string") {applicationID = parseInt(applicationID)};
	oauthModels.Application.findOne({ oauth_id: applicationID }, function(error, application) {
		if (application) {
			logger.log("debug", "[Oauth2] Starting Auth for application:" + application.title);
			var match = false, uri = url.parse(redirectURI || '');
			for (var i = 0; i < application.domains.length; i++) {
				logger.log('info', "[Oauth2] Checking OAuth redirectURI against defined service domain: " + application.domains[i]);
				if (uri.host == application.domains[i] || (uri.protocol == application.domains[i] && uri.protocol != 'http' && uri.protocol != 'https')) {
					match = true;
					logger.log('info', "[Oauth2] Found Service definition associated with redirectURI: " + redirectURI);
					break;
				}
			}
			if (match && redirectURI && redirectURI.length > 0) {
				done(null, application, redirectURI);
			} else {
				done(new Error("ERROR: Could not find service definition associated with redirectURI: ", redirectURI), false);
			}
		} else if (!error) {
			done(new Error("ERROR: No service definition associated with oauth client_id: ", applicationID), false);
		} else {
			done(error);
		}
	});
// Oauth Scopes
}),function(req,res){
	var scopeMap = {
		// ... display strings for all scope variables ...
		access_devices: 'access your devices',
		create_devices: 'create new devices'
	};

	res.render('pages/oauth', {
		transaction_id: req.oauth2.transactionID,
		currentURL: encodeURIComponent(req.originalUrl),
		response_type: req.query.response_type,
		errors: req.flash('error'),
		scopes: req.oauth2.req.scope,
		application: req.oauth2.client,
		user: req.user,
		map: scopeMap,
		brand: process.env.BRAND,
		title: "Link Account | " + process.env.BRAND
	});
});
///////////////////////////////////////////////////////////////////////////
// Finish
///////////////////////////////////////////////////////////////////////////
router.post('/finish',function(req,res,next) {
	if (req.user) {
		logger.log("debug", "[OAuth2] User already logged in:" + req.user.username);
		next();
	} else {
		passport.authenticate('local', {
			session: false
		}, function(error,user,info){
			//console.log("/auth/finish authenticating");
			if (user) {
				logger.log('info', "[Oauth2] Authenticated: " + user.username);
				req.user = user;
				next();
			} else if (!error){
				logger.log('warn', "[Oauth2] User not authenticated");
				req.flash('error', 'Your email or password was incorrect. Please try again.');
				res.redirect(req.body['auth_url'])
			}
			else {
				logger.log('error', "[Oauth2] Auth error: " + error);
			}
 		})(req,res,next);
	}
}, oauthServer.decision(function(req,done){
	//console.log("decision user: ", req);
	done(null, { scope: req.oauth2.req.scope });
}));


///////////////////////////////////////////////////////////////////////////
// Access Token URI
///////////////////////////////////////////////////////////////////////////
router.post('/exchange',function(req,res,next){
	var appID = req.body['client_id'];
	var appSecret = req.body['client_secret'];

	oauthModels.Application.findOne({ oauth_id: appID, oauth_secret: appSecret }, function(error, application) {
		if (application) {
			req.appl = application;
			logger.log("debug", "[Oauth2] Exchange application:" + application);
			next();
		} else if (!error) {
			error = new Error("ERROR: Could not find service definition associated with applicationID: " + appID + " or secret: " + appSecret);
			logger.log("debug", "[Oauth2] Could not find service definition associated with applicationID: " + appID + " or secret: " + appSecret);
			next(error);
		} else {
			logger.log("debug", "[Oauth2] Error:" + error);
			next(error);
		}
	});
}, oauthServer.token(), oauthServer.errorHandler());

module.exports = router;