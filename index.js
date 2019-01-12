var url = require('url');
var mqtt = require('mqtt');
var http = require('http');
var https = require('https');
var favicon = require('serve-favicon')
var flash = require('connect-flash');
var morgan = require('morgan');
var express = require('express');
const session = require('express-session');
const mongoStore = require('connect-mongo')(session);
var passport = require('passport');
var mongoose = require('mongoose');
var bodyParser = require('body-parser');
var cookieParser = require('cookie-parser');
var BasicStrategy = require('passport-http').BasicStrategy;
var LocalStrategy = require('passport-local').Strategy;
var PassportOAuthBearer = require('passport-http-bearer');
var oauthServer = require('./oauth');
var countries = require('countries-api');
var ua = require('universal-analytics');
const { format, createLogger, transports } = require('winston');
var enableAnalytics = true;
var consoleLoglevel = "info"; // default console log level

// Configure Logging, with Exception Handler
var debug = (process.env.ALEXA_DEBUG || false);
if (debug == "true") {consoleLoglevel = "debug"};

const logger = createLogger({
	transports: [
	  // Console Transport
	  new transports.Console({
		level: consoleLoglevel,
		format: format.combine(
		  format.timestamp(),
		  format.colorize(),
		  format.simple()
		),
		handleExceptions: true
	  })
	  // Will add AWS CloudWatch capability here as well
	]
  });

logger.log('info', "[Core] Log Level set to: " + consoleLoglevel);

// Create logger stream object for use with morgan
logger.stream = {
	write: function(message, encoding) {
	  // use the 'verbose' log level
	  logger.verbose(message);
	},
  };

// Use GA account ID specified in container definition
if (!(process.env.GOOGLE_ANALYTICS_TID)) {
	logger.log('warn',"[Core] UID for Google Analytics not supplied via environment variable GOOGLE_ANALYTICS_TID");
	enableAnalytics = false;
}
else {
	var visitor = ua(process.env.GOOGLE_ANALYTICS_TID);
}

// Validate CRITICAL environment variables passed to container
if (!(process.env.MONGO_USER && process.env.MONGO_PASSWORD && process.env.MQTT_USER && process.env.MQTT_PASSWORD && process.env.MQTT_PORT)) {
	logger.log('error',"[Core] You MUST supply MONGO_USER, MONGO_PASSWORD, MQTT_USER, MQTT_PASSWORD and MQTT_PORT environment variables");
	process.exit()
}
// Warn on not supply of MONGO/ MQTT host names
if (!(process.env.MONGO_HOST && process.env.MQTT_URL)) {
	logger.log('warn',"[Core] Using 'mongodb' for Mongodb and 'mosquitto' for MQTT service endpoints, no MONGO_HOST/ MQTT_URL environment variable supplied");
}
// Warn on not supply of MAIL username/ password/ server
if (!(process.env.MAIL_SERVER && process.env.MAIL_USER && process.env.MAIL_PASSWORD)) {
	logger.log('warn',"[Core] No MAIL_SERVER/ MAIL_USER/ MAIL_PASSWORD environment variable supplied. System generated emails will generate errors");
}

// NodeJS App Settings
var port = (process.env.VCAP_APP_PORT || 3000);
var host = (process.env.VCAP_APP_HOST || '0.0.0.0');

// MongoDB Settings
var mongo_user = (process.env.MONGO_USER);
var mongo_password = (process.env.MONGO_PASSWORD);
var mongo_host = (process.env.MONGO_HOST || "mongodb");
var mongo_port = (process.env.MONGO_PORT || "27017");
// MQTT Settings
var mqtt_user = (process.env.MQTT_USER);
var mqtt_password = (process.env.MQTT_PASSWORD);
var mqtt_port = (process.env.MQTT_PORT || "1883");
var mqtt_url = (process.env.MQTT_URL || "mqtt://mosquitto:" + mqtt_port);
// Express Settings
if (process.env.VCAP_APPLICATION) {
	var application = JSON.parse(process.env.VCAP_APPLICATION);
	var app_uri = application['application_uris'][0];
	app_id = 'https://' + app_uri;
}
else {
	var app_id = 'http://localhost:' + port;
}
var cookieSecret = 'ihytsrf334';

var mqttClient;

var mqttOptions = {
	connectTimeout: 30 * 1000,
	reconnectPeriod: 1000,
	keepAlive: 10,
	clean: true,
	resubscribe: true,
	clientId: 'webApp_' + Math.random().toString(16).substr(2, 8)
};

if (mqtt_user) {
	mqttOptions.username = mqtt_user;
	mqttOptions.password = mqtt_password;
}

logger.log('info', "[Core] Connecting to MQTT server: " + mqtt_url);
mqttClient = mqtt.connect(mqtt_url, mqttOptions);

mqttClient.on('error',function(err){
	logger.log('error', "[Core] MQTT connect error");
});

mqttClient.on('reconnect', function(){
	logger.log('warn', "[Core] MQTT reconnect event");
});

mqttClient.on('connect', function(){
	logger.log('info', "[Core] MQTT connected, subscribing to 'response/#'")
	mqttClient.subscribe('response/#');
	logger.log('info', "[Core] MQTT connected, subscribing to 'state/#'")
	mqttClient.subscribe('state/#');
});

// Connect to Mongo Instance
mongo_url = "mongodb://" + mongo_user +":" + mongo_password + "@" + mongo_host + ":" + mongo_port + "/users";
logger.log('info', "[Core] Connecting to MongoDB server: mongodb://" + mongo_host + ":" + mongo_port + "/users");
mongoose.Promise = global.Promise;
var mongoose_connection = mongoose.connection;

mongoose_connection.on('connecting', function() {
	logger.log('info', "[Core] Connecting to MongoDB...");
});

mongoose_connection.on('error', function(error) {
	logger.log('error', "[Core] MongoDB connection: " + error);
	//mongoose.disconnect();
});

mongoose_connection.on('connected', function() {
    logger.log('info', "[Core] MongoDB connected!");
});
  
mongoose_connection.once('open', function() {
    logger.log('info', "[Core] MongoDB connection opened!");
});

mongoose_connection.on('reconnected', function () {
    logger.log('info', "[Core] MongoDB reconnected!");
});

mongoose_connection.on('disconnected', function() {
	logger.log('warn', "[Core] MongoDB disconnected!");
});

// Fixes in relation to: https://github.com/Automattic/mongoose/issues/6922#issue-354147871
mongoose.set('useCreateIndex', true);
mongoose.set('useFindAndModify', false);

mongoose.connect(mongo_url, {
		useNewUrlParser: true,
		autoReconnect: true,
		reconnectTries: Number.MAX_VALUE,
		reconnectInterval: 1000
});

var Account = require('./models/account');
var oauthModels = require('./models/oauth');
var Devices = require('./models/devices');
var Topics = require('./models/topics');
var LostPassword = require('./models/lostPassword');

// Check admin account exists, if not create it using same credentials as MQTT user/password supplied
Account.findOne({username: mqtt_user}, function(error, account){
	if (!error && !account) {
		Account.register(new Account({username: mqtt_user, email: '', mqttPass: '', superuser: 1}),
			mqtt_password, function(err, account){
			var topics = new Topics({topics: [
					'command/' +account.username+'/#', 
					'state/' + account.username + '/#',
					'response/' + account.username + '/#'
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
								logger.log('error', err);
							}
						}
					);
				}
			});
		});
	} else {
		logger.log('info', "[Core] Superuser MQTT account, " + mqtt_user + " already exists");
	}
});

var app = express();

// Redis client, required by express-limiter
var client = require('redis').createClient({
	host: 'redis',
	retry_strategy: function (options) {
        if (options.error && options.error.code === 'ECONNREFUSED') {
			return new Error('The server refused the connection');
        }
        if (options.total_retry_time > 1000 * 60 * 60) {
			//logger.log('error', "[REDIS] Retry time exhausted");
			return new Error('Retry time exhausted');
        }
        if (options.attempt > 100) {
			// End reconnecting with built in error
			logger.log('error', "[Core] Redis server connection retry limit exhausted");
            return undefined;
        }
		// reconnect after
		//logger.log('error', "[REDIS] Attempting reconnection after set interval");
        return Math.min(options.attempt * 1000, 10000);
   	}
});

client.on('connect', function() {
    logger.log('info', "[Core] Connecting to Redis server...");
});

client.on('ready', function() {
    logger.log('info', "[Core] Redis connection ready!");
});

client.on('reconnecting', function() {
    logger.log('info', "[Core] Attempting to reconnect to Redis server");
});

client.on('error', function (err) {
    logger.log('error', "[Core] Unable to connect to Redis server");
});

// Rate-limiter 
const limiter = require('express-limiter')(app, client)

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

// Restrictive Limiter, used to prevenmt abuse on NewUser, Login, 10 reqs/ hr
const restrictiveLimiter = limiter({
	lookup: function(req, res, opts, next) {
		opts.lookup = 'connection.remoteAddress'
		opts.total = 10
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

app.set('view engine', 'ejs');
app.enable('trust proxy');
app.use(favicon('static/favicon.ico'));
app.use(morgan("combined", {stream: logger.stream})); // change to use Winston
app.use(cookieParser(cookieSecret));
app.use(flash());

// Session handler
app.use(session({
	store: new mongoStore({
		url: "mongodb://" + mongo_user +":" + mongo_password + "@" + mongo_host + ":" + mongo_port + "/sessions"
	}),
	resave: true,
	saveUninitialized: true,
	secret: 'ihytsrf334'
}));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(passport.initialize());
app.use(passport.session());

function requireHTTPS(req, res, next) {
	if (req.get('X-Forwarded-Proto') === 'http') {
        var url = 'https://' + req.get('host');
        if (req.get('host') === 'localhost') {
        	url += ':' + port;
        }
        url  += req.url;
        return res.redirect(url); 
    }
    next();
}

app.use(requireHTTPS);

app.use('/',express.static('static')); // Static content router
app.use('/octicons', express.static('node_modules/octicons/build'), express.static('node_modules/octicons/build/svg')); // Octicons router

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

app.get('/', defaultLimiter, function(req,res){
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

app.get('/docs', defaultLimiter, function(req,res){
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

app.get('/about', defaultLimiter, function(req,res){
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

app.get('/privacy', defaultLimiter, function(req,res){
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

app.get('/tos', defaultLimiter, function(req,res){
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

app.get('/login', defaultLimiter, function(req,res){
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

app.get('/logout', defaultLimiter, function(req,res){
	req.logout();
	if (req.query.next) {
		//console.log(req.query.next);
		res.redirect(req.query.next);
	} else {
		res.redirect('/');
	}
	
});

//app.post('/login',passport.authenticate('local', { failureRedirect: '/login', successRedirect: '/2faCheck', failureFlash: true }));
app.post('/login', restrictiveLimiter,
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

app.get('/newuser', defaultLimiter, function(req,res){
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

app.post('/newuser', restrictiveLimiter, function(req,res){
	var body = JSON.parse(JSON.stringify(req.body));
	if (body.hasOwnProperty('username') && body.hasOwnProperty('email') && body.hasOwnProperty('country') && body.hasOwnProperty('password')) {
		const country = countries.findByCountryCode(req.body.country.toUpperCase());
		Promise.all([country]).then(([userCountry]) => {
			if (country.statusCode == 200) {
				var region = userCountry.data[0].region;
				Account.register(new Account({ username : req.body.username, email: req.body.email, country: req.body.country.toUpperCase(), region: region,  mqttPass: "foo" }), req.body.password, function(err, account) {
					if (err) {
						logger.log('error', "[New User] New user creation error: " + err);
						return res.status(400).send(err.message);
					}
					var topics = new Topics({topics: [
							'command/' + account.username +'/#', 
							'state/'+ account.username + '/#',
							'response/' + account.username + '/#'
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
			logger.log('warn', "[New User] User region lookup failed.");
			res.status(500).send("Account creation failed, please check country is correctly specified!");
		});
	}
	else {
		logger.log('warn', "[New User] Missing/ incorrect elements supplied for user account creation");
		res.status(500).send("Missing required attributes, please check registration form!");
	}
});


app.get('/changePassword/:key', defaultLimiter, function(req, res, next){
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

app.get('/changePassword', defaultLimiter, ensureAuthenticated, function(req, res, next){
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

app.post('/changePassword', restrictiveLimiter, ensureAuthenticated, function(req, res, next){
	Account.findOne({username: req.user.username}, function (err, user){
		if (!err && user) {
			user.setPassword(req.body.password, function(e,u){
				// var s = Buffer.from(account.salt, 'hex').toString('base64');
				// var h = Buffer.from(account.hash, 'hex').toString(('base64'));
				var mqttPass = "PBKDF2$sha256$901$" + user.salt + "$" + user.hash;
				u.mqttPass = mqttPass;
				u.save(function(error){
					if (!error) {
						//console.log("Chagned %s's password", u.username);
						var params = {
							ec: "Security",
							ea: "Changed password for username:" + u.username,
							uid: req.user,
							dp: "/changePassword"
						  }
						if (enableAnalytics) {visitor.event(params).send()};
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

app.get('/lostPassword', defaultLimiter, function(req, res, next){
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

var sendemail = require('./sendemail');
var mailer = new sendemail();

app.post('/lostPassword', restrictiveLimiter, function(req, res, next){
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

// Oauth related code, some help here in getting this working: https://github.com/hardillb/alexa-oauth-test
// See README.md for Alexa Skill Authentication settings.

// Authorization URI
app.get('/auth/start',oauthServer.authorize(function(applicationID, redirectURI, done) {
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
			done(new Error("ERROR: No serevice definition associated with oauth client_id: ", applicationID), false);
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
		scope: req.oauth2.req.scope,
		application: req.oauth2.client,
		user: req.user,
		map: scopeMap
	});
});

app.post('/auth/finish',function(req,res,next) {
	//console.log("/auth/finish user: ", req.user);
	//console.log(req.body);
	//console.log(req.params);
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

// Access Token URI
app.post('/auth/exchange',function(req,res,next){
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

/////////////////////// Start GHome Additions
app.post('/api/v1/action', defaultLimiter,
	passport.authenticate(['bearer', 'basic'], { session: false }),
	function(req,res,next){
	logger.log('verbose', "[GHome API] Request:" + JSON.stringify(req.body));
	var intent = req.body.inputs[0].intent;
	var requestId = req.body.requestId;

	switch (intent) {
		///////////////////////////////////////////////////////////////////////////
		case 'action.devices.SYNC' :
			logger.log('verbose', "[GHome Sync API] Running device discovery for user:" + req.user.username);
			var findUser = Account.find({username: req.user.username});
			var findDevices = Devices.find({username: req.user.username});
			Promise.all([findUser, findDevices]).then(([user, devices]) => {
				if (user && devices) {
					// Build Device Array
					var devs = [];
					for (var i=0; i< devices.length; i++) {
						var dev = {}
						dev.id = "" + devices[i].endpointId;
						dev.type = gHomeReplaceType(devices[i].displayCategories);
						dev.traits = [];
						// Check supported device type
						if (dev.type != "NA") {
							// Check supported capability/ trait
							devices[i].capabilities.forEach(function(capability){
								var trait = gHomeReplaceCapability(capability);
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
						//dev.roomHint = devices[i].room; // Optional, will require schema extension
						dev.attributes = devices[i].attributes; // Disabled until attribute supported traits enabled

						// action.devices.traits.TemperatureSetting, adjust dev.attributes to suit Google Home
						if (dev.traits.indexOf("action.devices.traits.TemperatureSetting") > -1 ){
							dev.attributes.availableThermostatModes = dev.attributes.thermostatModes.map(function(x){return x.toLowerCase()});
							dev.attributes.thermostatTemperatureUnit = dev.attributes.temperatureScale.charAt(0).toUpperCase; // >> Need to make this upper F or C, so trim
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
					logger.log('verbose', "[GHome Sync API] Discovery Response: " + JSON.stringify(response));
					// Send Response
					res.status(200).json(response);
				}
				else if (!user){
					logger.log('warn', "[GHome Sync API] User not found");
					res.status(500).json({message: "User not found"});
				}
				else if (!device) {
					logger.log('warn', "[GHome Sync API] Device not found");
					res.status(500).json({message: "Device not found"});
				}
			}).catch(err => {
				logger.log('error', "[GHome Sync API] error:" + err)
				res.status(500).json({message: "An error occurred."});
			});
			break;

		///////////////////////////////////////////////////////////////////////////
		case 'action.devices.EXEC' : 
			logger.log('verbose', "[GHome Exec API] Execute command for user:" + req.user.username);
			var findDevices = Devices.find({username: req.user.username});
			Promise.all([findUser, findDevices]).then(([user, devices]) => {
				if (user && devices) {
					var arrCommandsDevices =  req.body.inputs[0].payload.commands[0].devices; // Array of devices to execute commands against
					var arrExecutions = req.body.inputs[0].payload.execution; // Array of commands, assume match with device array at same index?!

					for (var i=0; i< arrExecutions.length; i++) { // Iterate through commands in payload, against each listed 
						var params = arrExecutions[i].params; // Google Home Parameters
						var message; // Placeholder for MQTT Command
						// Transform Google command format into Alexa Command format (to avoid re-work on Node-RED Nodes, !need to revisit!)

						// Don't match to Alexa, in contrrib check for message details and match accordingly

						// action.devices.commands.OnOff
						// if (arrExecutions[i].command = "action.devices.commands.OnOff"){
						// 	logger.log('debug', "[GHome Exec API] OnOff command for user:" + req.user.username);
						// 	// Set MQTT Message with invalid/ placeholder endpointId
						// 	if (params.on == true) {
						// 		message = {"directive":{"header":{"namespace":"Alexa.PowerController","name":"TurnOn","payloadVersion":"3","messageId":requestId},"endpoint":{"scope":{"type":"BearerToken"},"endpointId":"0","cookie":{}},"payload":{}}};
						// 	}
						// 	else if (params.on == false) {
						// 		message = {"directive":{"header":{"namespace":"Alexa.PowerController","name":"TurnOff","payloadVersion":"3","messageId":requestId},"endpoint":{"scope":{"type":"BearerToken"},"endpointId":"0","cookie":{}},"payload":{}}};
						// 	}
						// }
						// // action.devices.commands.ActivateScene
						// if (arrExecutions[i].command = "action.devices.commands.ActivateScene"){
						// 	logger.log('debug', "[GHome Exec API] ActivateScene command for user:" + req.user.username);
						// 	message = {"directive":{"header":{"namespace":"Alexa.SceneController","name":"Activate","payloadVersion":"3","messageId":requestId},"endpoint":{"scope":{"type":"BearerToken"},"endpointId":"0","cookie":{}},"payload":{}}};
						// }
						// // action.devices.commands.BrightnessAbsolute
						// if (arrExecutions[i].command = "action.devices.commands.BrightnessAbsolute"){
						// 	logger.log('debug', "[GHome Exec API] BrightnessAbsolute command for user:" + req.user.username);
						// 	message = {"directive":{"header":{"namespace":"Alexa.BrightnessController","name":"SetBrightness","payloadVersion":"3","messageId":requestId},"endpoint":{"scope":{"type":"BearerToken"},"endpointId":"0","cookie":{}},"payload":{"brightness":params.brightness}}};
						// }
						// // action.devices.commands.ColorAbsolute
						// if (arrExecutions[i].command = "action.devices.commands.ColorAbsolute"){
						// 	logger.log('debug', "[GHome Exec API] ColorAbsolute command for user:" + req.user.username);
						// 	// ColorTemp command
						// 	if (params.color.hasOwnProperty('colorTemperature')){
						// 		message = {"directive":{"header":{"namespace":"Alexa.ColorTemperatureController","name":"SetColorTemperature","payloadVersion":"3","messageId":requestId},"endpoint":{"scope":{"type":"BearerToken"},"endpointId":"0","cookie":{}},"payload":{"colorTemperatureInKelvin":params.color.temperature}}};
						// 	}
						// 	// Color command
						// 	if (params.color.hasOwnProperty('spectrumHSV')){
						// 		message = {"directive":{"header":{"namespace":"Alexa.ColorController","name":"SetColor","payloadVersion":"3","messageId":requestId},"endpoint":{"scope":{"type":"BearerToken"},"endpointId":"0","cookie":{}},"payload":{"color":{"hue":params.color.spectrumHSV.hue,"saturation":params.color.spectrumHSV.saturation,"brightness":params.color.spectrumHSV.value}}}};
						// 	}
						// }

						// Add other supported command types here namely:
						// action.devices.commands.SetTemperature // will need validation that is in range
						// action.devices.commands.ThermostatTemperatureSetpoint // will need validation that is in range
						// action.devices.commands.ThermostatTemperatureSetRange // will need validation that is in range
						// action.devices.commands.ThermostatSetMode // will need validation that is in range

						// Match device to returned array in case of any required property/ validation
						arrCommandsDevices.forEach(function(element) {
							var data = devices.find(obj => obj.endpointId === element.id);
							logger.log('debug', "[GHome Exec API] Command to be executed against endpointId:" + element.id);
							
							// Set MQTT Topic
							var topic = "command/" + req.user.username + "/" + element.id;
							// Set MQTT endpointId
							//message.directive.endpoint.endpointId = "" + element.id;



							// Add "ghome" element to message to show it is a GHome API message, also include params variable
							//message.googlehome = {}
							//message.googlehome.params = params;

							// Check endpointIt not 0, then process command

							try{
								// Define MQTT Message
								var message = JSON.stringify({
									requestId: requestId,
									id: element.id,
									execution: arrExecutions[i]
								});
								//mqttClient.publish(topic,message); // Publish Command
								logger.log('verbose', "[GHome Exec API] Published MQTT command for user: " + req.user.username + " topic: " + topic);
								logger.log('debug', "[GHome Exec API] MQTT message:" + message);

							} catch (err) {
								logger.log('warn', "[GHome Exec API] Failed to publish MQTT command for user: " + req.user.username);
							}

							var command = {
								user: req.user.username,
								res: res,
								timestamp: Date.now()
							};

							logger.log('verbose', "[GHome Exec API] Added MQTT to Ongoing Commands buffer");
							logger.log('debug', "[GHome Exec API] Ongoing Command:" + JSON.stringify(command));

							//onGoingCommands[requestId] = command; // Command drops into buffer w/ 6000ms timeout (see defined funcitonm above) - ACK comes from N/R flow
							res.status(500).send();
							// Add response handler on MQTT message recieved where message hasOwnProperty googlehome, build and send expected response
						});
					}
				}
				else if (!user){
					logger.log('warn', "[GHome Exec API] User not found");
					res.status(500).json({message: "User not found"});
				}
				else if (!device) {
					logger.log('warn', "[GHome Exec API] Device not found");
					res.status(500).json({message: "Device not found"});
				}
			}).catch(err => {
				logger.log('error', "[GHome Exec API] error:" + err)
				res.status(500).json({message: "An error occurred."});
			});

			break;

		///////////////////////////////////////////////////////////////////////////
		case 'action.devices.QUERY' :
			logger.log('verbose', "[GHome Query API] Running device state query for user:" + req.user.username);
			var findUser = Account.find({username: req.user.username});
			var findDevices = Devices.find({username: req.user.username});
			Promise.all([findUser, findDevices]).then(([user, devices]) => {
				if (user && devices) {
					var arrQueryDevices = req.body.inputs[0].payload.devices;
					var response = {
						"requestId": requestId,
						"payload": {
							"devices" : {}
						}
					}
					for (var i=0; i< arrQueryDevices.length; i++) {
						// Find device in array of user devices returned in promise
						logger.log('debug', "[GHome Query API] Trying to match requested device: " + arrQueryDevices[i].id + " with user-owned endpointId");	
						var data = devices.find(obj => obj.endpointId == arrQueryDevices[i].id);
						if (data) {
							logger.log('verbose', "[GHome Query API] Matched requested device: " + arrQueryDevices[i].id + " with user-owned endpointId: " + data.endpointId);	
							// Create initial JSON object for device
							response.payload.devices[data.endpointId] = {online: true};
							// Add state response based upon device traits
							data.capabilities.forEach(function(capability){
								var trait = gHomeReplaceCapability(capability);

								// Limit supported traits, add new ones here once SYNC and gHomeReplaceCapability function updated
								if (trait == "action.devices.traits.Brightness"){
									response.payload.devices[data.endpointId].brightness = data.state.brightness;
								}
								if (trait == "action.devices.traits.ColorSetting") {
									if (!response.payload.devices[data.endpointId].hasOwnProperty('on')){
										response.payload.devices[data.endpointId].on = data.state.power.toLowerCase();
									}
									response.payload.devices[data.endpointId].color = {
											"temperatureK":data.state.colorTemperature,
											"spectrumHsv": {
											  "hue": data.state.colorHue,
											  "saturation": data.state.colorSaturation,
											  "value": data.state.colorBrightness
											}
										}
								}
								if (trait == "action.devices.traits.OnOff") {
									if (data.state.power.toLowerCase() == 'on') {
										response.payload.devices[data.endpointId].on = true;
									}
									else {
										response.payload.devices[data.endpointId].on = false;
									}
									
								}
								// if (trait == "action.devices.traits.Scene") {} // Only requires 'online' which is set above
								if (trait == "action.devices.traits.TemperatureSetting") {
									response.payload.devices[data.endpointId].thermostatMode = data.state.thermostatMode.toLowerCase();
									response.payload.devices[data.endpointId].thermostatTemperatureSetpoint = data.state.thermostatSetPoint;
								}
							});
						}
						else {
							logger.log('warn', "[GHome Query API] Unable to match a requested device with user endpointId");
						}
					}
					// Send Response
					logger.log('verbose', "[GHome Query API] QUERY state: " + JSON.stringify(response));
					res.status(200).json(response);
				}
				else if (!user){
					logger.log('warn', "[GHome Query API] User not found");
					res.status(500).json({message: "User not found"});
				}
				else if (!device) {
					logger.log('warn', "[GHome Query API] Device not found");
					res.status(500).json({message: "Device not found"});
				}

			}).catch(err => {
				logger.log('error', "[GHome Query API] error:" + err)
				res.status(500).json({message: "An error occurred."});
			});
			break;


		case 'action.devices.DISCONNECT' : 
			// Remove OAuth tokens for Google Home
			res.status(200).send();
			break; 
	}
});

// Convert Alexa Device Capabilities to Google Home-compatible
function gHomeReplaceCapability(capability) {
	// Limit supported traits, add new ones here
	if(capability == "PowerController") {return "action.devices.traits.OnOff"}
	else if(capability == "BrightnessController")  {return "action.devices.traits.Brightness"}
	else if(capability == "ColorController" || capability == "ColorTemperatureController"){return "action.devices.traits.ColorSetting"}
	else if(capability == "SceneController") {return "action.devices.traits.Scene"}
	else if(capability == "ThermostatController")  {return "action.devices.traits.TemperatureSetting"}
	else {return "Not Supported"}
}

// Convert Alexa Device Types to Google Home-compatible
function gHomeReplaceType(type) {
	// Limit supported device types, add new ones here
	if (type == "ACTIVITY_TRIGGER") {return "action.devices.types.SCENE"}
	else if (type == "LIGHT") {return "action.devices.types.LIGHT"}
	else if (type == "SMARTPLUG") {return "action.devices.types.OUTLET"}
	else if (type == "SWITCH") {return "action.devices.types.SWITCH"}
	else if (type == "THERMOSTAT") {return "action.devices.types.THERMOSTAT"}
	else {return "NA"}
}
/////////////////////// End GHome Additions



// Discovery API, can be tested via credentials of an account/ browsing to http://<ip address>:3000/api/v1/devices
app.get('/api/v1/devices', defaultLimiter,
	passport.authenticate(['bearer', 'basic'], { session: false }),
	function(req,res,next){

		//console.log("all good, doing discover devices");
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
					data[i].capabilities.forEach(function(capability){
						dev.capabilities.push(replaceCapability(capability, dev.reportState))
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
function replaceCapability(capability, reportState) {
	// console.log(capability)

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
              "supportedModes": [
                "HEAT",
                "COOL",
                "AUTO"
              ]
			}
		};
	}
};

var onGoingCommands = {};

// Event handler for received MQTT messages - note subscribe near top of script.
mqttClient.on('message',function(topic,message){
	var arrTopic = topic.split("/"); 
	var username = arrTopic[1];
	var endpointId = arrTopic[2];

	if (topic.startsWith('response/')){
		logger.log('info', "[Command API] Acknowledged MQTT response message for topic: " + topic);
		var payload = JSON.parse(message.toString());
		//console.log("response payload", payload)
		var commandWaiting = onGoingCommands[payload.messageId];
		if (commandWaiting) {
			//console.log("mqtt response: " + JSON.stringify(payload,null," "));
			if (payload.success) {
				commandWaiting.res.status(200).send();
				logger.log('debug', "[Command API] Successful MQTT Command API response");				
			} else {
				commandWaiting.res.status(503).send();
				logger.log('warn', "[Command API] Failed MQTT Command API response");
			}
			delete onGoingCommands[payload.messageId];
			var params = {
				ec: "Command",
				ea: "Command API successfully processed MQTT command for username: " + username,
				uid: username,
			  }
			if (enableAnalytics) {visitor.event(params).send()};
		}
	}
	else if (topic.startsWith('state/')){
		logger.log('info', "[State API] Acknowledged MQTT state message topic: " + topic);
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

// Get State API, gets device "state" element from MongoDB, used for device status review in Alexa App
app.get('/api/v1/getstate/:dev_id', getStateLimiter,
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
											break
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

// API to set device state in MongoDB
app.post('/api/v1/setstate/:dev_id',
	passport.authenticate(['bearer', 'basic'], { session: false }),
	function(req,res,next){
		// do nothing, disused for now, may use along side command API 
	}
);

// API to process/ execute inbound command
app.post('/api/v1/command',
	passport.authenticate('bearer', { session: false }),
	function(req,res,next){
		//console.log(req.user.username);
		//console.log(req);
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
				// Convert "model" object class to JSON object
				var deviceJSON = JSON.parse(JSON.stringify(data));
				var topic = "command/" + req.user.username + "/" + req.body.directive.endpoint.endpointId;
				var validationStatus = true;
				// Cleanup MQTT message
				delete req.body.directive.header.correlationToken;
				delete req.body.directive.endpoint.scope.token;
				var message = JSON.stringify(req.body);
				logger.log('debug', "[Command API] Received command API request for user: " + req.user.username + " command: " + message);
				// Check attributes.colorTemperatureRange, send 417 to Lambda (VALUE_OUT_OF_RANGE) response if values are out of range
				if (req.body.directive.header.namespace == "Alexa.ColorTemperatureController" && req.body.directive.header.name == "SetColorTemperature") {
					var compare = req.body.directive.payload.colorTemperatureInKelvin;
					// Handle Out of Range
					if (deviceJSON.hasOwnProperty('attributes')) {
						if (deviceJSON.attributes.hasOwnProperty('colorTemperatureRange')) {
							if (compare < data.attributes.colorTemperatureRange.temperatureMinK || compare > data.attributes.colorTemperatureRange.temperatureMaxK) {
								logger.log('warn', "[Command API] User: " + req.user.username + ", requested color temperature: " + compare + ", on device: " + req.body.directive.endpoint.endpointId + ", which is out of range: " + JSON.stringify(data.attributes.colorTemperatureRange));
								res.status(417).send();
								validationStatus = false;
							}
						}
					}
					else {logger.log('debug', "[Command API] Device: " + req.body.directive.endpoint.endpointId + " does not have data.attributes.colorTemperatureRange defined")}
				}

				// Check attributes.temperatureRange, send 416 to Lambda (TEMPERATURE_VALUE_OUT_OF_RANGE) response if values are out of range
				if (req.body.directive.header.namespace == "Alexa.ThermostatController" && req.body.directive.header.name == "SetTargetTemperature") {
					var compare = req.body.directive.payload.targetSetpoint.value;
					// Handle Temperature Out of Range
					if (deviceJSON.hasOwnProperty('attributes')) {
						if (deviceJSON.attributes.hasOwnProperty('temperatureRange')) {
							if (compare < data.attributes.temperatureRange.temperatureMin || compare > data.attributes.temperatureRange.temperatureMax) {
								logger.log('warn', "[Command API] User: " + req.user.username + ", requested temperature: " + compare + ", on device: " + req.body.directive.endpoint.endpointId + ", which is out of range: " + JSON.stringify(data.attributes.temperatureRange));
								res.status(416).send();
								validationStatus = false;
							}
						}
					}
					else {logger.log('debug', "[Command API] Device: " + req.body.directive.endpoint.endpointId + " does not have data.attributes.temperatureRange defined")}
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
						timestamp: Date.now()
					};
			
					// Command drops into buffer w/ 6000ms timeout (see defined funcitonm above) - ACK comes from N/R flow
					onGoingCommands[req.body.directive.header.messageId] = command;
				}
			}
		});
	}
);

app.get('/my-account', defaultLimiter,
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

		const user = Account.findOne({username: req.user.username});
		Promise.all([user]).then(([userAccount]) => {
			//logger.log('info', "userAccount: " + userAccount);
			res.render('pages/account',{user: userAccount, acc: true});
		}).catch(err => {
			res.status(500).json({error: err});
		});
});

app.get('/devices', defaultLimiter,
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
		const userDevices = Devices.find({username:user});
		const countDevices = Devices.countDocuments({username:user});
		const countGrants = Account.aggregate([
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

		Promise.all([userDevices, countDevices, countGrants]).then(([devices, countDevs, countUserGrants]) => {
			//logger.log('info', "Grant count for user: " + user + ", grants: " + countUserGrants[0].countGrants);
			//logger.log('info', "countUserGrants: " + JSON.stringify(countUserGrants));
			res.render('pages/devices',{user: req.user, devices: devices, count: countDevs, grants: countUserGrants[0].countGrants, devs: true});
		}).catch(err => {
			res.status(500).json({error: err});
		});
});

app.put('/devices', defaultLimiter,
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
			} else {
				res.status(500);
				res.send(err);
			}
		});

});

app.post('/account/:user_id', defaultLimiter,
	ensureAuthenticated,
	function(req,res){
		var user = req.body;
		if (req.user.username === mqtt_user || req.user.username == user.username) { // Check is admin user, or user themselves
			const country = countries.findByCountryCode(user.country.toUpperCase());
			Promise.all([country]).then(([userCountry]) => {
				if (country.statusCode == 200) {
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

app.delete('/account/:user_id', defaultLimiter,
	ensureAuthenticated,
	function(req,res){
		var userId = req.params.user_id;
		const user = Account.findOne({_id: userId});
		Promise.all([user]).then(([userAccount]) => {
			//logger.log('info', "userAccount: " + userAccount);
			//res.render('pages/account',{user: userAccount, acc: true});
			if (userAccount.username == req.user.username || req.user.username === mqtt_user) {
				const deleteAccount = Account.deleteOne({_id: userId});
				const deleteGrantCodes = oauthModels.GrantCode.deleteMany({user: userId});
				const deleteAccessTokens = oauthModels.AccessToken.deleteMany({user: userId});
				const deleteRefreshTokens = oauthModels.RefreshToken.deleteMany({user: userId});
				const deleteDevices = Devices.deleteMany({username: userAccount.username});
				const deleteTopics = Topics.deleteOne({_id:userAccount.topics});
				Promise.all([deleteAccount, deleteGrantCodes, deleteAccessTokens, deleteRefreshTokens, deleteDevices, deleteTopics]).then(result => {
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

app.post('/device/:dev_id', defaultLimiter,
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
					}
				});
		}
});

app.delete('/device/:dev_id', defaultLimiter,
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
					}
				});
		}
});

app.post('/api/v1/devices', defaultLimiter,
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
		} else {
			res.error(400);
		}
	}
);

app.get('/admin/services', defaultLimiter,
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
		
			const applications = oauthModels.Application.find({});
			Promise.all([applications]).then(([apps]) => {
					res.render('pages/services',{user:req.user, services: apps});
				}).catch(err => {
					res.status(500).json({error: err});
				});
		} else {
			res.status(401).send();
		}
});

app.get('/admin/users', defaultLimiter,
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

			const countUsers = Account.countDocuments({});
			const usersAndCountDevices = Account.aggregate([
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
			Promise.all([countUsers, usersAndCountDevices]).then(([totalCount, usersAndDevs]) => {
				//logger.log('info', "users: " + users)
				//logger.log('info', "totalCount: " + totalCount)
				//logger.log('info', "usersAndDevs: " + JSON.stringify(usersAndDevs));
				res.render('pages/users',{user:req.user, users: usersAndDevs, usercount: totalCount});
			}).catch(err => {
				res.status(500).json({error: err});
			});
		}
		else {
			res.status(401).send();
		}
});

app.get('/admin/user-devices', defaultLimiter,
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

			const userDevices = Devices.find({});
			const countDevices = Devices.countDocuments({});
			Promise.all([userDevices, countDevices]).then(([devices, count]) => {
				res.render('pages/user-devices',{user:req.user, devices: devices, devicecount: count});
			}).catch(err => {
				res.status(500).json({error: err});
			});
	} else {
			res.status(401).send();
		}
});

// One-time, sync Alexa and Google Home data, this will copy device.validRange to device.attributes element
// app.get('/admin/update-schema', defaultLimiter,
// 	ensureAuthenticated,
// 	function(req,res){
// 		if (req.user.username === mqtt_user) {
// 			const userDevices = Devices.find({});
// 			Promise.all([userDevices]).then(([devices]) => {
// 				//logger.log('info', JSON.stringify(devices));
// 				devices.forEach(dev => {
// 					if (dev) {
// 						dev.validRange = dev.validRange;
// 						dev.attributes = ( dev.attributes || {});
// 						logger.log('info', "endpointId:" + dev.endpointId + ":" + JSON.stringify(dev));
// 						var hasAttributes = false;
// 						if (dev.capabilities.indexOf("ThermostatController") > -1) { // Thermostat
// 							if (dev.validRange.minimumValue > 0 && dev.validRange.maximumValue > 0) {
// 								hasAttributes = true;
// 								dev.attributes.temperatureRange = {};
// 								dev.attributes.temperatureRange.temperatureMin = dev.validRange.minimumValue;
// 								dev.attributes.temperatureRange.temperatureMax = dev.validRange.maximumValue;
// 								dev.attributes.temperatureScale = dev.validRange.scale.toUpperCase();
// 								dev.attributes.thermostatModes = ["HEAT", "COOL", "AUTO"]; // All declared devices currently have this by nature of discovery response
// 							}
// 						}
// 						if (dev.capabilities.indexOf("ColorController") > -1) { // ColorController
// 							if (dev.validRange.minimumValue > 0 &&  dev.validRange.maximumValue > 100) {
// 								hasAttributes = true;
// 								dev.attributes.colorModel = "hsv";
// 								dev.attributes.colorTemperatureRange = {};
// 								dev.attributes.colorTemperatureRange.temperatureMinK = dev.validRange.minimumValue;
// 								dev.attributes.colorTemperatureRange.temperatureMaxK = dev.validRange.maximumValue;
// 							}
// 						}
// 						if (dev.capabilities.indexOf("SceneController") > -1) { // Scene
// 							hasAttributes = true;
// 							dev.attributes.sceneReversible = true;
// 						}
// 						if (dev.capabilities.indexOf("TemperatureSensor") > -1) { // Thermostat
// 							hasAttributes = true;
// 							dev.attributes.temperatureScale = dev.validRange.scale;
// 						}
// 						if (hasAttributes == true) {
// 							logger.log('info', "endpointId: " + dev.endpointId + ", CHANGED, new dev.attributes value: " + JSON.stringify(dev.attributes));
// 							Devices.updateOne({_id:dev._id}, { $set: { attributes: dev.attributes }}, function(err, data) {
// 							 	if (err) {
// 							 		logger.log('warn', "ERROR updating dev.attributes for endpointId: " + dev.endpointId);
// 							 	}
// 							 	else {logger.log('info', "SUCCESS Updated dev.attributes for endpointId: " + dev.endpointId);}
// 							});
// 						} else {
// 							logger.log('info', "endpointId: " + dev.endpointId + ", NO CHANGE");
// 						}
// 					}
// 				});
// 				res.status(200).send();
// 			}).catch(err => {
// 				res.status(500).json({error: err});
// 			});
// 		} else {
// 			res.status(401).send();
// 		}
// });

app.put('/services', defaultLimiter,
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

app.post('/service/:id', defaultLimiter,
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

app.delete('/service/:id', defaultLimiter,
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

// Create HTTPS Server
//var certKey = "/etc/letsencrypt/live/" + process.env.WEB_HOSTNAME + "/privkey.pem";
//var certChain = "/etc/letsencrypt/live/" + process.env.WEB_HOSTNAME + "/fullchain.pem";
// var options = {
// 	key: fs.readFileSync(certKey),
// 	cert: fs.readFileSync(certChain)
// };
// var server = https.createServer(options, app);

// Create HTTP Server, to be proxied
var server = http.Server(app);

server.listen(port, host, function(){
	logger.log('info', "[Core] App listening on: " + host + ":" + port);
	logger.log('info', "[Core] App_ID -> " + app_id);
	setTimeout(function(){
	},5000);
});

// Set State Function, sets device "state" element in MongoDB based upon Node-RED MQTT 'state' message
function setstate(username, endpointId, payload) {
	// Check payload has state property
	logger.log('debug', "[State API] SetState payload:" + JSON.stringify(payload));
	if (payload.hasOwnProperty('state')) {
		// Find existing device, we need to retain state elements, state is fluid/ will contain new elements so flattened input no good
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
						if (newTemp < dev.state.thermostatSetPoint ) {newMode = "COOL"}
						else {newMode = "HEAT"}

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
						// Compare stored vs requested temperature, set state to HEAT/ COOl depending on difference
						if (dev.state.thermostatSetPoint < payload.state.thermostatSetPoint) {dev.state.thermostatMode = "HEAT"}
						else if (dev.state.thermostatSetPoint > payload.state.thermostatSetPoint) {dev.state.thermostatMode = "COOL"}
						dev.state.thermostatSetPoint = payload.state.thermostatSetPoint;
					}
					else {dev.state.thermostatMode = "HEAT"}
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
