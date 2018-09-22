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
//var Measurement = require('./googleMeasurement.js');

/* // Validate CRITICAL environment variables passed to container
if (process.env.WEB_HOSTNAME && process.env.MONGO_USER && process.env.MONGO_PASSWORD && process.env.MQTT_USER && process.env.MQTT_PASSWORD ) {
	console.log("ERROR: You MUST supply WEB_HOSTNAME, MONGO_USER, MONGO_PASSWORD, MQTT_USER and MQTT_PASSWORD environment variables.")
	process.exit()
}

if (process.env.MONGO_HOST && process.env.MQTT_URL ) {
	console.log("WARNING: using DNS_HOSTNAME for Mongodb and MQTT service endpoints, no MONGO_HOST/ MQTT_URL environment variable supplied.")
}

if (process.env.MAIL_SERVER && process.env.MAIL_USER && process.env.MAIL_PASSWORD ) {
	console.log("WARNING: no MAIL_SERVER/ MAIL_USER/ MAIL_PASSWORD environment variable supplied. System generated emails will generate errors.")
} */

// Service-wide Settings
var dnsHostname = (process.env.WEB_HOSTNAME || undefined);
// NodeJS App Settings
var port = (process.env.PORT || 3000);
var host = ('0.0.0.0');
var certKey = "/etc/letsencrypt/live/" + dnsHostname + "/privkey.pem";
var certChain = "/etc/letsencrypt/live/" + dnsHostname + "/fullchain.pem";
// MongoDB Settings
var mongo_user = (process.env.MONGO_USER || undefined);
var mongo_password = (process.env.MONGO_PASSWORD || undefined);
var mongo_host = (process.env.MONGO_HOST || dnsHostname);
var mongo_port = (process.env.MONGO_PORT || "27017");
// MQTT Settings
var mqtt_user = (process.env.MQTT_USER || undefined);
var mqtt_password = (process.env.MQTT_PASSWORD || undefined);
var mqtt_url = (process.env.MQTT_URL || "mqtt://" + dnsHostname + ":1883");
console.log(mqtt_url);

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

mqttClient = mqtt.connect(mqtt_url, mqttOptions);

mqttClient.on('error',function(err){
	console.log("MQTT connect error");
});

mqttClient.on('reconnect', function(){
	console.log("MQTT reconnect");
});

mqttClient.on('connect', function(){
	console.log("MQTT connected")
	mqttClient.subscribe('response/#');
});

// Connect to Mongo Instance
mongo_url = "mongodb://" + mongo_user +":" + mongo_password + "@" + mongo_host + ":" + mongo_port + "/users";
console.log(mongo_url)
mongoose.Promise = global.Promise;
var mongoose_connection = mongoose.connection;

mongoose_connection.on('connecting', function() {
	console.log('connecting to MongoDB...');
});

mongoose_connection.on('error', function(error) {
	console.error('Error in MongoDb connection: ' + error);
	//mongoose.disconnect();
});

mongoose_connection.on('connected', function() {
    console.log('MongoDB connected!');
});
  
mongoose_connection.once('open', function() {
    console.log('MongoDB connection opened!');
});

mongoose_connection.on('reconnected', function () {
    console.log('MongoDB reconnected!');
});

mongoose_connection.on('disconnected', function() {
	console.log('MongoDB disconnected!');
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
								console.log(err);
							}
						}
					);
				}
			});
		});
	} else {
		console.log("Superuser MQTT account already exists");
	}
});

var app_id = 'http://localhost:' + port;

if (process.env.VCAP_APPLICATION) {
	var application = JSON.parse(process.env.VCAP_APPLICATION);

	var app_uri = application['application_uris'][0];

	app_id = 'https://' + app_uri;
}

var cookieSecret = 'ihytsrf334';

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
			console.log("missing grant token: %j", token);
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

app.get('/login', function(req,res){
	res.render('pages/login',{user: req.user, message: req.flash('error')});
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
	res.render('pages/register',{user: req.user});
});

app.post('/newuser', function(req,res){
	Account.register(new Account({ username : req.body.username, email: req.body.email, mqttPass: "foo" }), req.body.password, function(err, account) {
		if (err) {
			console.log(err);
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
							console.log(err);
						}
					}
				);
			}
		});

		passport.authenticate('local')(req, res, function () {
			console.log("created new user %s", req.body.username);
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
					console.log(err);
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
						console.log("Error changing %s's password", u.username);
						console.log(error);
						res.status(400).send("Problem setting new password");
					}
				});
			});
		} else {
			console.log(err);
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
					mailer.send(email, 'no-reply@cb-net.co.uk', 'Password Reset for Node-Red-Alexa-Smart-Home-v3', body.text, body.html);
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
				console.log("Checking redirectURI against defined service domain: " + application.domains[i])
				if (uri.host == application.domains[i] || (uri.protocol == application.domains[i] && uri.protocol != 'http' && uri.protocol != 'https')) {
					match = true;
					console.log("Found service definition associated with redirecURI: " + redirectURI);
					break;
				}
			}
			if (match && redirectURI && redirectURI.length > 0) {
				done(null, application, redirectURI);
			} else {
				done(new Error("Could not find service definition associated with redirectURI: " + redirectURI), false);
			}
		} else if (!error) {
			done(new Error("No serevice definition associated with oauth client_id: " + applicationID), false);
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
				console.log("Authenticated: " + user.username);
				req.user = user;
				next();
			} else if (!error){
				console.log("Not Authenticated");
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
			error = new Error("Could not find service definition associated with applicationID: " + appID + " or secret: " + appSecret);
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
	if(capability == "SceneController ") {
		return {
			"type": "AlexaInterface",
			"interface": "Alexa.SceneController",
			"version" : "3",
			"supportsDeactivation" : false
		  };
	}

	// ThermostatController
	// if(capability == "ThermostatController")  {
	// 	return [{
	// 			"type": "AlexaInterface",
	// 			"interface": "Alexa.ThermostatController",
	// 			"version": "3", 
	// 			"properties": {
	// 				"supported": [{
	// 						"name": "targetSetpoint"
	// 					},
	// 					{
	// 						"name": "lowerSetpoint"
	// 					},
	// 					{
	// 						"name": "upperSetpoint"
	// 					},
	// 					{
	// 						"name": "thermostatMode"
	// 					}
	// 				],
	// 				"proactivelyReported": false,
	// 				"retrievable": false
	// 			}
	// 	}];
	// }
	// LightController
	// if(capability == "LightController")  {
	// 	return [{ 
	// 			"type": "AlexaInterface",
	// 			"interface": "Alexa.PowerController",
	// 			"version": "3",
	// 			"properties": {
	// 				"supported": [{
	// 					"name": "powerState"
	// 				}],
	// 				"proactivelyReported": false,
	// 				"retrievable": false
	// 			}
	// 		},
	// 		{
	// 			"type": "AlexaInterface",
	// 			"interface": "Alexa.ColorController",
	// 			"version": "3",
	// 			"properties": {
	// 				"supported": [{
	// 					"name": "color"
	// 				}],
	// 				"proactivelyReported": false,
	// 				"retrievable": false
	// 			}
	// 		},
	// 		{
	// 			"type": "AlexaInterface",
	// 			"interface": "Alexa.ColorTemperatureController",
	// 			"version": "3",
	// 			"properties": {
	// 				"supported": [{
	// 					"name": "colorTemperatureInKelvin"
	// 				}],
	// 				"proactivelyReported": false,
	// 				"retrievable": false
	// 			}
	// 		},
	// 		{
	// 			"type": "AlexaInterface",
	// 			"interface": "Alexa.BrightnessController",
	// 			"version": "3",
	// 			"properties": {
	// 				"supported": [{
	// 					"name": "brightness"
	// 				}],
	// 				"proactivelyReported": false,
	// 				"retrievable": false
	// 			}
	// 		}
	// 	]};
};

var onGoingCommands = {};

// Event handler for received MQTT messages - note subscribe near top of script.
mqttClient.on('message',function(topic,message){
	if (topic.startsWith('response/')){
		console.log("Acknowledged MQTT response")
		var payload = JSON.parse(message.toString());
		//console.log("response payload", payload)
		var waiting = onGoingCommands[payload.messageId];
		if (waiting) {
			//console.log("mqtt response: " + JSON.stringify(payload,null," "));
			if (payload.success) {
				waiting.res.status(200);
				if (payload.extra) {
					//console.log("sending extra");
					console.log("Sent succesfull HTTP response, with extra MQTT data.")
					waiting.res.send(payload.extra);
				} else {
					//console.log("not sending extra");
					console.log("Sent succesfull HTTP response, no extra MQTT data.")
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
		console.log("Unhandled MQTT via on message event handler", topic, message);
	}
});

// Interval funciton, runs every 500ms once defined via setInterval: https://www.w3schools.com/js/js_timing.asp
var timeout = setInterval(function(){
	var now = Date.now();
	var keys = Object.keys(onGoingCommands);
	for (key in keys){
		var waiting = onGoingCommands[keys[key]];
		console.log(keys[key]);
		if (waiting) {
			var diff = now - waiting.timestamp;
			if (diff > 6000) {
				console.log("timed out");
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
		var topic = "command/" +req.user.username + "/" + req.body.directive.endpoint.endpointId;
		//console.log("topic", topic)
		delete req.body.directive.header.correlationToken;
		delete req.body.directive.endpoint.scope.token;
		//console.log(req.body)
		var message = JSON.stringify(req.body);
		console.log("message",message)
		try{
			mqttClient.publish(topic,message);
			console.log("Published MQTT command!")
		} catch (err) {
			console.log("Error publishing MQTT command!")
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
		console.log(id);
		Devices.deleteOne({_id: id, username: user},
			function(err) {
				if (err) {
					console.log(err);
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

// Create HTTPS Server Instance
var options = {
	key: fs.readFileSync(certKey),
	cert: fs.readFileSync(certChain)
};
server = https.createServer(options, app);

// Moved to HTTPS-only
/* var server = http.Server(app);
if (app_id.match(/^https:\/\/localhost:/)) {
	var options = {
		key: fs.readFileSync('server.key'),
		cert: fs.readFileSync('server.crt')
	};
	server = https.createServer(options, app);
}  */

server.listen(port, host, function(){
	console.log('App listening on  %s:%d!', host, port);
	console.log("App_ID -> %s", app_id);

	setTimeout(function(){
		
	},5000);
});
