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
	log2console("CRITICAL","You MUST supply MONGO_USER, MONGO_PASSWORD, MQTT_USER, MQTT_PASSWORD and MQTT_PORT environment variables");
	process.exit()
}
// Warn on not supply of MONGO/ MQTT host names
if (!(process.env.MONGO_HOST && process.env.MQTT_URL)) {
	log2console("WARNING","Using WEB_HOSTNAME for Mongodb and MQTT service endpoints, no MONGO_HOST/ MQTT_URL environment variable supplied");
}
// Warn on not supply of MAIL username/ password/ server
if (!(process.env.MAIL_SERVER && process.env.MAIL_USER && process.env.MAIL_PASSWORD)) {
	log2console("WARNING","No MAIL_SERVER/ MAIL_USER/ MAIL_PASSWORD environment variable supplied. System generated emails will generate errors");
}

// NodeJS App Settings
var port = (process.env.PORT || 3000);
var host = ('0.0.0.0');
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
var app_id = 'http://localhost:' + port;
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

log2console("INFO", "Connecting to MQTT server: " + mqtt_url);
mqttClient = mqtt.connect(mqtt_url, mqttOptions);

mqttClient.on('error',function(err){
	log2console("ERROR", "MQTT connect error");
});

mqttClient.on('reconnect', function(){
	log2console("WARNING", "MQTT reconnect event");
});

mqttClient.on('connect', function(){
	log2console("INFO", "MQTT connected, subscribing to 'response/#'")
	mqttClient.subscribe('response/#');
});

// Connect to Mongo Instance
mongo_url = "mongodb://" + mongo_user +":" + mongo_password + "@" + mongo_host + ":" + mongo_port + "/users";
log2console("INFO", "Connecting to MongoDB server: mongodb://" + mongo_host + ":" + mongo_port + "/users");
mongoose.Promise = global.Promise;
var mongoose_connection = mongoose.connection;

mongoose_connection.on('connecting', function() {
	log2console("INFO", "Connecting to MongoDB...");
});

mongoose_connection.on('error', function(error) {
	log2console("ERROR: MongoDB connection: " + error);
	//mongoose.disconnect();
});

mongoose_connection.on('connected', function() {
    log2console("INFO", "MongoDB connected!");
});
  
mongoose_connection.once('open', function() {
    log2console("INFO", "MongoDB connection opened!");
});

mongoose_connection.on('reconnected', function () {
    log2console("INFO", "MongoDB reconnected!");
});

mongoose_connection.on('disconnected', function() {
	log2console("WARNING", "MongoDB disconnected!");
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
					'presence/' + account.username + '/#',
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
		log2console("INFO", "Superuser MQTT account, " + mqtt_user + " already exists");
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

// express.session not supported in production
/* app.use(session({
  // genid: function(req) {
  //   return genuuid() // use UUIDs for session IDs
  // },
  secret: cookieSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
  	//secure: true
  }
})); */

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
			log2console("ERROR", "Missing grant token:" + token);
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
	console.log("Req:", req)
	console.log("Req username:", req.body.username)
	console.log("Req email:", req.body.email)
	console.log("Req country:", req.body.country)
	var response = countries.findByCountryCode(req.body.country.toUpperCase());
	log2console("DEBUG", "User country:", req.body.country);
	if (response.statusCode == 200) {
		log2console("DEBUG", "User region would be: " + response.data.region);
	}
	else {
		log2console("DEBUG", "User region lookup failed.");
		log2console("DEBUG", response);
	} 	// What to do if Region fails?

	Account.register(new Account({ username : req.body.username, email: req.body.email, country: req.body.country, mqttPass: "foo" }), req.body.password, function(err, account) {
		if (err) {
			log2console("ERROR", "New user creation error: " + err);
			return res.status(400).send(err.message);
		}

		var topics = new Topics({topics: [
				'command/' + account.username +'/#', 
				'presence/'+ account.username + '/#',
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
							log2console("ERROR" , "New user creation error updating MQTT info: " + err);
						}
					}
				);
			}
		});

		passport.authenticate('local')(req, res, function () {
			log2console("INFO", "Created new user " + req.body.username);
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
					log2console("ERROR", "Password reset failed for user: " + lostPassword.user);
					log2console("DEBUG", err);
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
						log2console("ERROR", "Unable to change password for: " + u.username);
						log2console("DEBUG", error);
						res.status(400).send("Problem setting new password");
					}
				});
			});
		} else {
			log2console("ERROR", "Unable to change password for user, user not found: " + req.user.username);
			log2console("DEBUG: ", err);
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
					log2console("INFO", "Found Service definition associated with redirecURI: " + redirectURI);
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


// Discover devices, can be tested via credentials of an account/ browsing to http://<ip address>:3000/api/v1/devices
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
				var devs = [];
				for (var i=0; i< data.length; i++) {
					var dev = {};
					dev.friendlyName = data[i].friendlyName;
					dev.description = data[i].description;
					dev.endpointId = "" + data[i].endpointId;
					// Call replaceCapability to replace placeholder capabilities
					// dev.capabilities = replaceCapability(data[i].capabilities);

					// Handle multiple capabilities
					dev.capabilities = [];
					data[i].capabilities.forEach(function(capability){
						dev.capabilities.push(replaceCapability(capability))
					});

					dev.displayCategories = data[i].displayCategories;
					dev.cookie = data[i].cookie;
					dev.version = "0.0.2";
					dev.manufacturerName = "Node-RED"
					devs.push(dev);
				}
				//console.log(devs)
				res.send(devs);
			}	
		});
	}
);

// Alexa discovery response related-capabilties, function replaces 'placeholders' stored under device.capabilities
function replaceCapability(capability) {
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
				"retrievable": false
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
				"retrievable": false
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
			  "retrievable": false
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
					"retrievable": false
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
					"retrievable": false
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
					"retrievable": false
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
					"retrievable": false
				}
			};
	}


};

var onGoingCommands = {};

// Event handler for received MQTT messages - note subscribe near top of script.
mqttClient.on('message',function(topic,message){
	if (topic.startsWith('response/')){
		log2console("INFO", "Acknowledged MQTT response for topic: " + topic);
		var payload = JSON.parse(message.toString());
		//console.log("response payload", payload)
		var waiting = onGoingCommands[payload.messageId];
		if (waiting) {
			//console.log("mqtt response: " + JSON.stringify(payload,null," "));
			if (payload.success) {
				waiting.res.status(200);
				if (payload.extra) {
					//console.log("sending contents from payload.extra");
					log2console("INFO", "Sent succesfull HTTP response, with extra MQTT data.");
					waiting.res.send(payload.extra);
				} else {
					//console.log("not sending extra");
					log2console("INFO", "Sent succesfull HTTP response, no extra MQTT data.");
					waiting.res.send({});
				}
			} else {
				if (payload.extra && payload.extra.min) {
					//console.log("out of range");
					waiting.res.status(416).send(payload.extra);
				} else {
					//console.log("malfunction");
					waiting.res.status(503).send();
				}
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
	else {
		log2console("DEBUG", "Unhandled MQTT via on message event handler: " + topic + message);
	}
});

// Interval funciton, runs every 500ms once defined via setInterval: https://www.w3schools.com/js/js_timing.asp
var timeout = setInterval(function(){
	var now = Date.now();
	var keys = Object.keys(onGoingCommands);
	for (key in keys){
		var waiting = onGoingCommands[keys[key]];
		log2console("INFO", "Queued MQTT message: " + keys[key]);
		if (waiting) {
			var diff = now - waiting.timestamp;
			if (diff > 6000) {
				log2console("ERROR", "MQTT command timed out/ unacknowledged: " + keys[key]);
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
		var topic = "command/" + req.user.username + "/" + req.body.directive.endpoint.endpointId;
		//console.log("topic", topic)
		delete req.body.directive.header.correlationToken;
		delete req.body.directive.endpoint.scope.token;
		//console.log(req.body)
		var message = JSON.stringify(req.body);
		log2console("DEBUG", "Received MQTT command for user: " + req.user.username + " command: " + message);
		try{
			mqttClient.publish(topic,message);
			log2console("INFO", "Published MQTT command for user: " + req.user.username + " topic: " + topic);
		} catch (err) {
			log2console("ERROR", "Failed to publish MQTT command for user: " + req.user.username);
		}
		var command = {
			user: req.user.username,
			res: res,
			timestamp: Date.now()
		};

		// Command drops into buffer w/ 6000ms timeout (see defined funcitonm above)
		// Expect timeout is associated with requirement for NodeRed flow? Assume this is awaiting acknowledge from NodeRed node
		onGoingCommands[req.body.directive.header.messageId] = command;
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
			} else {
				res.status(500);
				res.send(err);
			}
		});

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
		log2console("INFO", "Deleted device id: " + id + " for user: " + req.user.username);
		Devices.deleteOne({_id: id, username: user},
			function(err) {
				if (err) {
					log2console("ERROR", "Unable to delete device id: " + id + " for user: " + req.user.username, err);
					res.status(500);
					res.send(err);
				} else {
					res.status(202);
					res.send();
				}
			});
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

app.get('/admin',
	ensureAuthenticated,
	function(req,res){
		if (req.user.username == mqtt_user) {
			Account.countDocuments({},function(err, count){
				res.render('pages/admin',{user:req.user, userCount: count});
			});
		} else {
			res.redirect('/');
		}
});

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
			Account.find({}, function(error, data){
				res.send(data);
			});
		} else {
			res.status(401).send();
		}
});

app.get('/admin/devices',
	ensureAuthenticated,
	function(req,res){
		if (req.user.username === mqtt_user) {
			Devices.find({},function(error, data){
				res.send(data);
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
	log2console("INFO", "App listening on: " + host + ":" + port);
	log2console("INFO", "App_ID -> " + app_id);

	setTimeout(function(){
		
	},5000);
});

function log2console(severity,message) {
	var dt = new Date().toISOString();
	var prefixStr = "[" + dt + "] " + "[" + severity + "]"
	console.log(prefixStr, message);
};
