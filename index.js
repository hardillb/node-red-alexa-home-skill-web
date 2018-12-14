var fs = require('fs');
var url = require('url');
var rfs = require('rotating-file-stream');
var mqtt = require('mqtt');
var path = require('path');
var http = require('http');
var https = require('https');
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
//var Measurement = require('./googleMeasurement.js');

// Validate CRITICAL environment variables passed to container
if (!(process.env.MONGO_USER && process.env.MONGO_PASSWORD && process.env.MQTT_USER && process.env.MQTT_PASSWORD && process.env.MQTT_PORT)) {
	log2console("CRITICAL","[Core] You MUST supply MONGO_USER, MONGO_PASSWORD, MQTT_USER, MQTT_PASSWORD and MQTT_PORT environment variables");
	process.exit()
}
// Warn on not supply of MONGO/ MQTT host names
if (!(process.env.MONGO_HOST && process.env.MQTT_URL)) {
	log2console("WARNING","[Core] Using 'mongodb' for Mongodb and 'mosquitto' for MQTT service endpoints, no MONGO_HOST/ MQTT_URL environment variable supplied");
}
// Warn on not supply of MAIL username/ password/ server
if (!(process.env.MAIL_SERVER && process.env.MAIL_USER && process.env.MAIL_PASSWORD)) {
	log2console("WARNING","[Core] No MAIL_SERVER/ MAIL_USER/ MAIL_PASSWORD environment variable supplied. System generated emails will generate errors");
}

// NodeJS App Settings
var port = (process.env.VCAP_APP_PORT || 3000);
var host = (process.env.VCAP_APP_HOST || '0.0.0.0');
var debug = (process.env.ALEXA_DEBUG || false)
// MongoDB Settings
var mongo_user = (process.env.MONGO_USER || undefined);
var mongo_password = (process.env.MONGO_PASSWORD || undefined);
var mongo_host = (process.env.MONGO_HOST || "mongodb");
var mongo_port = (process.env.MONGO_PORT || "27017");
// MQTT Settings
var mqtt_user = (process.env.MQTT_USER || undefined);
var mqtt_password = (process.env.MQTT_PASSWORD || undefined);
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
//var googleAnalyicsTID = process.env.GOOGLE_ANALYTICS_TID;
//var measurement = new Measurement(googleAnalyicsTID);

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

log2console("INFO", "[Core] Connecting to MQTT server: " + mqtt_url);
mqttClient = mqtt.connect(mqtt_url, mqttOptions);

mqttClient.on('error',function(err){
	log2console("ERROR", "[Core] MQTT connect error");
});

mqttClient.on('reconnect', function(){
	log2console("WARNING", "[Core] MQTT reconnect event");
});

mqttClient.on('connect', function(){
	log2console("INFO", "[Core] MQTT connected, subscribing to 'response/#'")
	mqttClient.subscribe('response/#');
	log2console("INFO", "[Core] MQTT connected, subscribing to 'state/#'")
	mqttClient.subscribe('state/#');
});

// Connect to Mongo Instance
mongo_url = "mongodb://" + mongo_user +":" + mongo_password + "@" + mongo_host + ":" + mongo_port + "/users";
log2console("INFO", "[Core] Connecting to MongoDB server: mongodb://" + mongo_host + ":" + mongo_port + "/users");
mongoose.Promise = global.Promise;
var mongoose_connection = mongoose.connection;

mongoose_connection.on('connecting', function() {
	log2console("INFO", "[Core] Connecting to MongoDB...");
});

mongoose_connection.on('error', function(error) {
	log2console("ERROR", "[Core] MongoDB connection: " + error);
	//mongoose.disconnect();
});

mongoose_connection.on('connected', function() {
    log2console("INFO", "[Core] MongoDB connected!");
});
  
mongoose_connection.once('open', function() {
    log2console("INFO", "[Core] MongoDB connection opened!");
});

mongoose_connection.on('reconnected', function () {
    log2console("INFO", "[Core] MongoDB reconnected!");
});

mongoose_connection.on('disconnected', function() {
	log2console("WARNING", "[Core] MongoDB disconnected!");
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
								log2console("ERROR", err);
							}
						}
					);
				}
			});
		});
	} else {
		log2console("INFO", "[Core] Superuser MQTT account, " + mqtt_user + " already exists");
	}
});

var logDirectory = path.join(__dirname, 'log');
fs.existsSync(logDirectory) || fs.mkdirSync(logDirectory);

var accessLogStream = rfs('access.log', {
  interval: '1d', // rotate daily
  compress: 'gzip', // compress rotated files
  maxFiles: 30,
  path: logDirectory
});

var app = express();
app.set('view engine', 'ejs');
app.enable('trust proxy');
app.use(morgan("combined", {stream: accessLogStream}));
app.use(cookieParser(cookieSecret));
app.use(flash());

// Moved from express.session to connect-mongo
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
        //FYI this should work for local development as well
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

app.use('/',express.static('static'));

passport.use(new LocalStrategy(Account.authenticate()));

passport.use(new BasicStrategy(Account.authenticate()));

passport.serializeUser(Account.serializeUser());
passport.deserializeUser(Account.deserializeUser());

var accessTokenStrategy = new PassportOAuthBearer(function(token, done) {
	oauthModels.AccessToken.findOne({ token: token }).populate('user').populate('grant').exec(function(error, token) {
		if (!error && token && !token.grant) {
			log2console("ERROR", "[Core] Missing grant token:" + token);
		}
		if (!error && token && token.active && token.grant && token.grant.active && token.user) {
			//console.log("Token is GOOD!");
			done(null, token.user, { scope: token.scope });
		} else if (!error) {
			//console.log("TOKEN PROBLEM");
			done(null, false);
		} else {
			//console.log("TOKEN PROBLEM 2");
			done(error);
		}
	});
});

passport.use(accessTokenStrategy);

app.get('/', function(req,res){
	res.render('pages/index', {user: req.user, home: true});
});

app.get('/docs', function(req,res){
	res.render('pages/docs', {user: req.user, docs: true});
});

app.get('/about', function(req,res){
	res.render('pages/about', {user: req.user, about: true});
});

app.get('/privacy', function(req,res){
	res.render('pages/privacy', {user: req.user, privacy: true});
});

app.get('/login', function(req,res){
	res.render('pages/login',{user: req.user, login: true, message: req.flash('error')});
});

app.get('/logout', function(req,res){
	req.logout();
	if (req.query.next) {
		//console.log(req.query.next);
		res.redirect(req.query.next);
	} else {
		res.redirect('/');
	}
	
});

//app.post('/login',passport.authenticate('local', { failureRedirect: '/login', successRedirect: '/2faCheck', failureFlash: true }));
app.post('/login',
	passport.authenticate('local',{ failureRedirect: '/login', failureFlash: true, session: true }),
	function(req,res){
		//console.log("login success");
		//console.log(req.isAuthenticated());
		//console.log(req.user);
		if (req.query.next) {
			res.reconnect(req.query.next);
		} else {
			//console.log("passed Auth");
			res.redirect('/devices');
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

app.get('/newuser', function(req,res){
	res.render('pages/register',{user: req.user, newuser: true});
});

app.post('/newuser', function(req,res){
	// Lookup Region for AWS Lambda/ Web API Skill Interaction
	var country = countries.findByCountryCode(req.body.country.toUpperCase());
	var region;
	// log2console("DEBUG", "User country: " + req.body.country.toUpperCase());
	if (country.statusCode == 200) {
		//log2console("DEBUG", "[New User] User region: " + country.data[0].region);
		// Use first array object, should always be singular data object returned via countries-api
		region = country.data[0].region;
	}
	else {
		log2console("WARNING", "[New User] User region lookup failed.");
		log2console("WARNING", "[New User] " + country);
		region = "Unknown";
	} 

	Account.register(new Account({ username : req.body.username, email: req.body.email, country: req.body.country.toUpperCase(), region: region,  mqttPass: "foo" }), req.body.password, function(err, account) {
		if (err) {
			log2console("ERROR", "[New User] New user creation error: " + err);
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
							log2console("ERROR" , "[New User] New user creation error updating MQTT info: " + err);
						}
					}
				);
			}
		});

		passport.authenticate('local')(req, res, function () {
			log2console("INFO", "[New User] Created new user, username: " + req.body.username + " email:"  + req.body.email + " country:" +  req.body.country + " region:" + region );
			//measurement.send({
			//	t:'event', 
			//	ec:'System', 
			//	ea: 'NewUser',
			//	uid: req.body.username
			//});
            res.status(201).send();
        });

	});
});


app.get('/changePassword/:key',function(req, res, next){
	var uuid = req.params.key;
	LostPassword.findOne({uuid: uuid}).populate('user').exec(function(error, lostPassword){
		if (!error && lostPassword) {
			req.login(lostPassword.user, function(err){
				if (!err){
					lostPassword.remove();
					res.redirect('/changePassword');
				} else {
					log2console("ERROR", "[Change Password] Password reset failed for user: " + lostPassword.user);
					log2console("DEBUG", "[Change Password] " + err);
					res.redirect('/');
				}
			})
		} else {
			res.redirect('/');
		}
	});
});

app.get('/changePassword', ensureAuthenticated, function(req, res, next){
	res.render('pages/changePassword', {user: req.user});
});

app.post('/changePassword', ensureAuthenticated, function(req, res, next){
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
						res.status(200).send();
					} else {
						log2console("ERROR", "[Change Password] Unable to change password for: " + u.username);
						log2console("DEBUG", "[Change Password] " + error);
						res.status(400).send("Problem setting new password");
					}
				});
			});
		} else {
			log2console("ERROR", "[Change Password] Unable to change password for user, user not found: " + req.user.username);
			log2console("DEBUG: ", "[Change Password] " + err);
			res.status(400).send("Problem setting new password");
		}
	});
});

app.get('/lostPassword', function(req, res, next){
	res.render('pages/lostPassword', { user: req.user});
});

var sendemail = require('./sendemail');
var mailer = new sendemail();

app.post('/lostPassword', function(req, res, next){
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
	oauthModels.Application.findOne({ oauth_id: applicationID }, function(error, application) {
		if (application) {
			var match = false, uri = url.parse(redirectURI || '');
			for (var i = 0; i < application.domains.length; i++) {
				log2console("INFO", "Checking OAuth redirectURI against defined service domain: " + application.domains[i]);
				if (uri.host == application.domains[i] || (uri.protocol == application.domains[i] && uri.protocol != 'http' && uri.protocol != 'https')) {
					match = true;
					log2console("INFO", "Found Service definition associated with redirectURI: " + redirectURI);
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
		next();
	} else {
		passport.authenticate('local', {
			session: false
		}, function(error,user,info){
			//console.log("/auth/finish authenticating");
			if (user) {
				log2console("INFO", "Authenticated: " + user.username);
				req.user = user;
				next();
			} else if (!error){
				log2console("WARNING", "Not Authenticated");
				req.flash('error', 'Your email or password was incorrect. Please try again.');
				res.redirect(req.body['auth_url'])
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
			next();
		} else if (!error) {
			error = new Error("ERROR: Could not find service definition associated with applicationID: " + appID + " or secret: " + appSecret);
			next(error);
		} else {
			next(error);
		}
	});
}, oauthServer.token(), oauthServer.errorHandler());


// Discovery API, can be tested via credentials of an account/ browsing to http://<ip address>:3000/api/v1/devices
app.get('/api/v1/devices',
	passport.authenticate(['bearer', 'basic'], { session: false }),
	function(req,res,next){

		//console.log("all good, doing discover devices");
		//measurement.send({
		//	t:'event', 
		//	ec:'discover', 
		//	ea: req.body.header ? req.body.header.name : "Node-RED",
		//	uid: req.user.username
		//});

		var user = req.user.username
		Devices.find({username: user},function(error, data){
			if (!error) {
				log2console("INFO", "[Discover API] Running device discovery for user:" + user);
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

	// PlaybackController w/ PowerController
	if(capability == "PlaybackPowerController") {
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
			},
			{
			"type": "AlexaInterface",
			"interface": "Alexa.PlaybackController",
			"version": "3",
			"supportedOperations" : ["Play", "Pause", "Stop"]
			};
	}

	// PlaybackController
	if(capability == "PlaybackController") {
		return {
			"type": "AlexaInterface",
			"interface": "Alexa.PlaybackController",
			"version": "3",
			"supportedOperations" : ["Play", "Pause", "Stop"]
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

	// SceneController 
	if(capability == "SceneController") {
		return {
			"type": "AlexaInterface",
			"interface": "Alexa.SceneController",
			"version" : "3",
			"supportsDeactivation" : false
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


};

var onGoingCommands = {};

// Event handler for received MQTT messages - note subscribe near top of script.
mqttClient.on('message',function(topic,message){
	if (topic.startsWith('response/')){
		log2console("INFO", "[Command API] Acknowledged MQTT response message for topic: " + topic);
		var payload = JSON.parse(message.toString());
		//console.log("response payload", payload)
		var commandWaiting = onGoingCommands[payload.messageId];
		if (commandWaiting) {
			//console.log("mqtt response: " + JSON.stringify(payload,null," "));
			if (payload.success) {
				commandWaiting.res.status(200).send();
				log2console("DEBUG", "[Command API] Successful MQTT Command API response");				
			} else {
				commandWaiting.res.status(503).send();
				log2console("ERROR", "[Command API] Failed MQTT Command API response");
			}
			delete onGoingCommands[payload.messageId];
			// should really parse uid out of topic
			//measurement.send({
			//	t:'event', 
			//	ec:'command', 
			//	ea: 'complete',
			//	uid: waiting.user
			//});
		}
	}
	else if (topic.startsWith('state/')){
		log2console("INFO", "[State API] Acknowledged MQTT state message topic: " + topic);
		// Split topic/ get username and endpointId
		var arrTopic = topic.split("/"); 
		var username = arrTopic[1];
		var endpointId = arrTopic[2];
		var messageJSON = JSON.parse(message);
		var payload = messageJSON.payload;
		// Call setstate to update attribute in mongodb
		setstate(username,endpointId,payload) //arrTopic[1] is username, arrTopic[2] is endpointId
		// Add message to onGoingCommands
		var stateWaiting = onGoingCommands[payload.messageId];
		if (stateWaiting) {
			if (payload.success) {
				log2console("INFO", "[State API] Succesful MQTT state update for user:" + username + " device:" + endpointId);
				stateWaiting.res.status(200).send();
			} else {
				log2console("ERROR", "[State API] Failed MQTT state update for user:" + username + " device:" + endpointId);
				stateWaiting.res.status(503).send();
			}
		}
		// If successful remove messageId from onGoingCommands
		delete onGoingCommands[payload.messageId];
		// should really parse uid out of topic
		//measurement.send({
		//	t:'event', 
		//	ec:'command', 
		//	ea: 'complete',
		//	uid: waiting.user
		//});
	}
	else {
		log2console("DEBUG", "[MQTT] Unhandled MQTT via on message event handler: " + topic + message);
	}
});

// Interval funciton, runs every 500ms once defined via setInterval: https://www.w3schools.com/js/js_timing.asp
var timeout = setInterval(function(){
	var now = Date.now();
	var keys = Object.keys(onGoingCommands);
	for (key in keys){
		var waiting = onGoingCommands[keys[key]];
		log2console("DEBUG", "[MQTT] Queued MQTT message: " + keys[key]);
		if (waiting) {
			var diff = now - waiting.timestamp;
			if (diff > 6000) {
				log2console("ERROR", "[MQTT] MQTT command timed out/ unacknowledged: " + keys[key]);
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
app.get('/api/v1/getstate/:dev_id',
	passport.authenticate(['bearer', 'basic'], { session: false }),
	function(req,res,next){
		//console.log(req.user.username);
		//console.log(req);
		//measurement.send({
		//	e:'event', 
		//	ec:'command', 
		//	ea: req.body.directive.header.name,
		//	uid: req.user.username
		//
		//});

		// Identify device, we know who user is from request
		var id = req.params.dev_id;
		log2console("DEBUG", "[State API] Received GetState API request for user:" + req.user.username + " endpointId:" + id);

		Devices.findOne({username:req.user.username, endpointId:id}, function(err, data){
			if (!err) {
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
														"uncertaintyInMilliseconds": 1000
													});
											}
											break;
										case "ColorController":
											// Return color
											if (deviceJSON.state.hasOwnProperty('colorHue') && deviceJSON.state.hasOwnProperty('colorSaturation') && deviceJSON.state.hasOwnProperty('brightness') && deviceJSON.state.hasOwnProperty('time')) {
												properties.push({
														"namespace": "Alexa.ColorController",
														"name": "color",
														"value": {
															"hue": deviceJSON.state.colorHue,
															"saturation": deviceJSON.state.colorSaturation,
															"brightness": deviceJSON.state.brightness
														},
														"timeOfSample": deviceJSON.state.time,
														"uncertaintyInMilliseconds": 1000
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
														"uncertaintyInMilliseconds": 1000
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
														"uncertaintyInMilliseconds": 1000
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
														"uncertaintyInMilliseconds": 1000
													});
											}
											break;
										case "PlaybackController":
											// Return Playback State - no reportable state as of November 2018
											break;
										case "PowerController":
											// Return Power State
											if (deviceJSON.state.hasOwnProperty('power') && deviceJSON.state.hasOwnProperty('time')) {
												properties.push({
															"namespace": "Alexa.PowerController",
															"name": "powerState",
															"value": deviceJSON.state.power,
															"timeOfSample": deviceJSON.state.time,
															"uncertaintyInMilliseconds": 1000
													});
											}
											break;
										case "ThermostatController":
											// Return Temperature
											if (deviceJSON.state.hasOwnProperty('thermostatSetPoint') && deviceJSON.state.hasOwnProperty('thermostatMode') && deviceJSON.state.hasOwnProperty('time')) {
												properties.push({
														"namespace":"Alexa.ThermostatController",
														"name":"targetSetpoint",
														"value":{  
															"value":deviceJSON.state.thermostatSetPoint,
															"scale":deviceJSON.validRange.scale.toUpperCase()
															},
														"timeOfSample":deviceJSON.state.time,
														"uncertaintyInMilliseconds":1000
													});
												properties.push({
														"namespace":"Alexa.ThermostatController",
														"name":"thermostatMode",
														"value":deviceJSON.state.thermostatMode,
														"timeOfSample":deviceJSON.state.time,
														"uncertaintyInMilliseconds":1000
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
									"uncertaintyInMilliseconds": 0
								});

								res.status(200).json(properties);
								}
							else {
								// Device has no state, return as such
								log2console("WARNING","[State API] No state found for username: " + req.user.username + " endpointId:" + id);
								res.status(500).send();
							}
						}
						// State reporting not enabled for device, send error code
						else {
							log2console("DEBUG","[State API] State requested for user: " + req.user.username + " device: " + id +  " but device state reporting disabled");
							var properties = [];
							properties.push({
								"namespace": "Alexa.EndpointHealth",
								"name": "connectivity",
								"value": {
								  "value": "OK"
								},
								"timeOfSample": deviceJSON.state.time,
								"uncertaintyInMilliseconds": 0
							});

							//res.status(500).send();
							res.status(200).json(properties);
						}
					}
					// 'reportState' element missing on device, send error code
					else {
						log2console("WARNING", "[State API] User: " + req.user.username + " device: " + id +  " has no reportState attribute, check MongoDB schema");
						res.status(500).send();
					}
				}
			else {
				// Device not found
				log2console("WARNING","[State API] No device found for username: " + req.user.username + " endpointId:" + id);
				res.status(500).send();
			}
		});
 	}
);

// API to set device state in MongoDB
app.post('/api/v1/setstate',
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
		//measurement.send({
		//	e:'event', 
		//	ec:'command', 
		//	ea: req.body.directive.header.name,
		//	uid: req.user.username
		//
		//});
		Devices.findOne({username:req.user.username, endpointId:req.body.directive.endpoint.endpointId}, function(err, data){
			if (!err) {
				// Convert "model" object class to JSON object
				var deviceJSON = JSON.parse(JSON.stringify(data));
				var topic = "command/" + req.user.username + "/" + req.body.directive.endpoint.endpointId;
				var validationStatus = true;
				// Cleanup MQTT message
				delete req.body.directive.header.correlationToken;
				delete req.body.directive.endpoint.scope.token;
				var message = JSON.stringify(req.body);
				log2console("DEBUG", "[Command API] Received command API request for user: " + req.user.username + " command: " + message);
				// Check validRange, send 417 to Lambda (VALUE_OUT_OF_RANGE) response if values are out of range
				if (req.body.directive.header.namespace == "Alexa.ColorTemperatureController" && req.body.directive.header.name == "SetColorTemperature") {
					var compare = req.body.directive.payload.colorTemperatureInKelvin;
					// Handle Out of Range
					if (deviceJSON.hasOwnProperty('validRange')) {
						if (compare < data.validRange.minimumValue || compare > data.validRange.maximumValue) {
							log2console("WARNING", "[Command API] User: " + req.user.username + ", requested color temperature: " + compare + ", on device: " + req.body.directive.endpoint.endpointId + ", which is out of range: " + JSON.stringify(data.validRange));
							res.status(417).send();
							validationStatus = false;
						}
					}
					else {log2console("DEBUG", "[Command API] Device: " + req.body.directive.endpoint.endpointId + " does not have validRange defined")}
				}

				// Check validRange, send 416 to Lambda (TEMPERATURE_VALUE_OUT_OF_RANGE) response if values are out of range
				if (req.body.directive.header.namespace == "Alexa.ThermostatController" && req.body.directive.header.name == "SetTargetTemperature") {
					var compare = req.body.directive.payload.targetSetpoint.value;
					// Handle Temperature Out of Range
					if (deviceJSON.hasOwnProperty('validRange')) {
						if (compare < data.validRange.minimumValue || compare > data.validRange.maximumValue) {
							log2console("WARNING", "[Command API] User: " + req.user.username + ", requested temperature: " + compare + ", on device: " + req.body.directive.endpoint.endpointId + ", which is out of range: " + JSON.stringify(data.validRange));
							res.status(416).send();
							validationStatus = false;
						}
					}
					else {log2console("DEBUG", "[Command API] Device: " + req.body.directive.endpoint.endpointId + " does not have validRange defined")}
				}
				
				if (validationStatus) {
					try{
						mqttClient.publish(topic,message);
						log2console("INFO", "[Command API] Published MQTT command for user: " + req.user.username + " topic: " + topic);
					} catch (err) {
						log2console("ERROR", "[Command API] Failed to publish MQTT command for user: " + req.user.username);
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
			else {
				log2console("ERROR", "[Command API] Unable to lookup device: " + req.body.directive.endpoint.endpointId + " for user: " + req.user.username);
				res.status(404).send();
			}
		});
	}
);

app.get('/devices',
	ensureAuthenticated,
	function(req,res){
		var user = req.user.username;

		Devices.find({username:user}, function(err, data){
			if (!err) {
				//console.log(data);
				res.render('pages/devices',{user: req.user ,devices: data, devs: true});
			}
		});
});

app.put('/devices',
	ensureAuthenticated,
	function(req,res){

		var user = req.user.username;
		var device = req.body;

		device.username = user;
		device.isReachable = true;

		var dev = new Devices(device);
		dev.save(function(err, dev){
			if (!err) {
				res.status(201)
				res.send(dev);
				log2console("DEBUG", "[Devices] New device created: " + JSON.stringify(dev));
			} else {
				res.status(500);
				res.send(err);
			}
		});

});

app.post('/account/:user_id',
	ensureAuthenticated,
	function(req,res){
		if (req.user.username === mqtt_user) { // Check is admin user
			// Lookup Region for AWS Lambda/ Web API Skill Interaction
			var country = countries.findByCountryCode(req.body.country.toUpperCase());
			var region;
			// log2console("DEBUG", "User country: " + req.body.country.toUpperCase());
			if (country.statusCode == 200) {
				//log2console("DEBUG", "User region: " + country.data[0].region);
				// Use first array object, should always be singular data object returned via countries-api
				region = country.data[0].region;
			}
			else {
				log2console("DEBUG", "User region lookup failed.");
				log2console("DEBUG", country);
				region = "Unknown";
			} 

			Account.findOne({_id: req.params.user_id},
				function(err, data){
					if (err) {
						log2console("ERROR", "[Admin] Unable to update user account: " + req.params.user_id, err);
						res.status(500);
						res.send(err);
					} else {
						log2console("INFO", "[Admin] Updated to user account: " + req.params.user_id);
						data.email = req.body.email;
						data.country = req.body.country;
						data.region = region;
						data.save(function(err, d){
							res.status(201);
							res.send(d);
						});
					}
				});
		}
});

app.delete('/account/:user_id',
	ensureAuthenticated,
	function(req,res){
		if (req.user.username === mqtt_user) { // Check is admin user
			// Multiple vars for each step of clean-up
			var userId = req.params.user_id;
			const deleteAccount = Account.deleteOne({_id: userId});
			const deleteGrantCodes = oauthModels.GrantCode.deleteMany({user: userId});
			const deleteAccessTokens = oauthModels.AccessToken.deleteMany({user: userId});
			const deleteRefreshTokens = oauthModels.RefreshToken.deleteMany({user: userId});
			Promise.all([deleteAccount, deleteGrantCodes, deleteAccessTokens, deleteRefreshTokens]).then(result => {
				//log2console("INFO", result);
				res.status(202).json({message: 'deleted'});
				log2console("INFO", "[Admin] Deleted user account: " + userId);
			}).catch(err => {
				log2console("ERROR", "[Admin] Failed to delete user account: " + userId);
				res.status(500).json({error: err});
			});
		}
});

app.post('/device/:dev_id',
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
						data.validRange = device.validRange;
						data.save(function(err, d){
							res.status(201);
							res.send(d);
						});
					}
				});
		}
});

app.delete('/device/:dev_id',
	ensureAuthenticated,
	function(req,res){
		var user = req.user.username;
		var id = req.params.dev_id;
		if (user != "mqtt-user") {
			Devices.deleteOne({_id: id, username: user},
				function(err) {
					if (err) {
						log2console("ERROR", "[Device] Unable to delete device id: " + id + " for user: " + req.user.username, err);
						res.status(500);
						res.send(err);
					} else {
						log2console("INFO", "[Device] Deleted device id: " + id + " for user: " + req.user.username);
						res.status(202);
						res.send();
					}
				});
		}
		else if (user == "mqtt-user") {
			Devices.deleteOne({_id: id},
				function(err) {
					if (err) {
						log2console("ERROR", "[Admin] Unable to delete device id: " + id, err);
						res.status(500);
						res.send(err);
					} else {
						log2console("INFO", "[Admin] Superuser deleted device id: " + id);
						res.status(202);
						res.send();
					}
				});
		}
});

app.post('/api/v1/devices',
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

// app.get('/admin',
// 	ensureAuthenticated,
// 	function(req,res){
// 		if (req.user.username == mqtt_user) {
// 			Account.countDocuments({},function(err, count){
// 				res.render('pages/admin',{user:req.user, userCount: count});
// 			});
// 		} else {
// 			res.redirect('/');
// 		}
// });

app.get('/admin/services',
	ensureAuthenticated, 
	function(req,res){
		if (req.user.username === mqtt_user) {
			oauthModels.Application.find({}, function(error, data){
				if (!error){
					res.render('pages/services',{user:req.user, services: data});
				}
			});
		} else {
			res.status(401).send();
		}
});

app.get('/admin/users',
	ensureAuthenticated,
	function(req,res){
		if (req.user.username === mqtt_user) {
			// https://docs.mongodb.com/manual/reference/method/db.collection.find/#explicitly-excluded-fields
			const userAccounts = Account.find({});
			const countUsers = Account.countDocuments({});
			Promise.all([userAccounts, countUsers]).then(result => {
				// result[0] = userAccounts, result[1] =  countUsers
				res.render('pages/users',{user:req.user, users: result[0], usercount: result[1]});
			}).catch(err => {
				res.status(500).json({error: err});
			});
		}
		else {
			res.status(401).send();
		}
	});

app.get('/admin/user-devices',
	ensureAuthenticated,
	function(req,res){
		if (req.user.username === mqtt_user) {
			// https://docs.mongodb.com/manual/reference/method/db.collection.find/#explicitly-excluded-fields
			const userDevices = Devices.find({});
			const countDevices = Account.countDocuments({});
			Promise.all([userDevices, countDevices]).then(result => {
				// result[0] = userDevices, result[1] =  countDevices
				res.render('pages/user-devices',{user:req.user, devices: result[0], devicecount: result[1]});
			}).catch(err => {
				res.status(500).json({error: err});
			});
	} else {
			res.status(401).send();
		}
	});

app.put('/services',
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

app.post('/service/:id',
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

app.delete('/service/:id',
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
	log2console("INFO", "[Core] App listening on: " + host + ":" + port);
	log2console("INFO", "[Core] App_ID -> " + app_id);

	setTimeout(function(){
		
	},5000);
});

// Set State Function, sets device "state" element in MongoDB based upon Node-RED MQTT 'state' message
function setstate(username, endpointId, payload) {
	// Check payload has state property
	log2console("DEBUG", "[State API] SetState payload:" + JSON.stringify(payload));
	if (payload.hasOwnProperty('state')) {
		// Find existing device, we need to retain state elements, state is fluid/ will contain new elements so flattened input no good
		Devices.findOne({username:username, endpointId:endpointId},function(error,dev){
			if (!error) {
				var dt = new Date().toISOString();
				
				// Check for device state element and create state object if does not exist on device			
				dev.state = dev.state || {};

				dev.state.time = dt;
				if (payload.state.hasOwnProperty('power')) {dev.state.power = payload.state.power}
				if (payload.state.hasOwnProperty('colorTemperature')) {dev.state.colorTemperature = payload.state.colorTemperature}
				if (payload.state.hasOwnProperty('brightness')) {dev.state.brightness = payload.state.brightness};
				if (payload.state.hasOwnProperty('colorHue')) {dev.state.colorHue = payload.state.colorHue};
				if (payload.state.hasOwnProperty('colorSaturation')) {dev.state.colorSaturation = payload.state.colorSaturation};
				if (payload.state.hasOwnProperty('input')) {dev.state.input = payload.state.input};
				if (payload.state.hasOwnProperty('lock')) {dev.state.lock = payload.state.lock};
				if (payload.state.hasOwnProperty('playback')) {dev.state.playback = payload.state.playback};
				if (payload.state.hasOwnProperty('thermostatSetPoint')) {
					if (dev.state.hasOwnProperty('thermostatSetPoint')) {
						// Compare stored vs requested temperature, set state to HEAT/ COOl depending on difference
						if (dev.state.thermostatSetPoint < payload.state.thermostatSetPoint) {dev.state.thermostatMode = "HEAT"}
						else if (dev.state.thermostatSetPoint > payload.state.thermostatSetPoint) {dev.state.thermostatMode = "COOL"}
						dev.state.thermostatSetPoint = payload.state.thermostatSetPoint;
					}
					else {dev.state.thermostatMode = "HEAT"}
				}
				log2console("DEBUG", "[State API] Endpoint state update: " + JSON.stringify(dev.state));
				// Update state element with modified properties
				Devices.updateOne({username:username, endpointId:endpointId}, { $set: { state: dev.state }}, function(err, data) {
					if (err) {
						log2console("DEBUG", "[State API] Error updating state for endpointId: " + endpointId);
					}
					else {log2console("DEBUG", "[State API] Updated state for endpointId: " + endpointId);}
				});
			}
			else {
				log2console("WARNING", "[State API] Unable to find enpointId: " + endpointId + " for username: " + username);
			}
		});
	}
	else {
		log2console("WARNING", "[State API] setstate called, but MQTT payload has no 'state' property!");
	}
}

function log2console(severity,message) {
	var dt = new Date().toISOString();
	var prefixStr = "[" + dt + "] " + "[" + severity + "]"
	if (severity == "DEBUG" && debug)
		console.log(prefixStr, message);
	else if (severity != "DEBUG") {
		console.log(prefixStr, message);
	}
};

