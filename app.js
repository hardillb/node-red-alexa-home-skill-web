///////////////////////////////////////////////////////////////////////////
// Depends
///////////////////////////////////////////////////////////////////////////
var favicon = require('serve-favicon')
var flash = require('connect-flash');
var morgan = require('morgan');
var express = require('express');
const session = require('express-session');
const mongoStore = require('connect-mongo')(session);
var passport = require('passport');
var bodyParser = require('body-parser');
var cookieParser = require('cookie-parser');
///////////////////////////////////////////////////////////////////////////
// MongoDB
///////////////////////////////////////////////////////////////////////////
var db = require('./config/db');
// Schema =======================
var Account = require('./models/account');
var Topics = require('./models/topics');
var passport = require('passport');
var BasicStrategy = require('passport-http').BasicStrategy;
var LocalStrategy = require('passport-local').Strategy;
var logger = require('./config/logger');
///////////////////////////////////////////////////////////////////////////
// Variables
///////////////////////////////////////////////////////////////////////////
var debug = (process.env.ALEXA_DEBUG || false);
// MongoDB Settings, used for expression session handler DB connection
var mongo_user = (process.env.MONGO_USER);
var mongo_password = (process.env.MONGO_PASSWORD);
var mongo_host = (process.env.MONGO_HOST || "mongodb");
var mongo_port = (process.env.MONGO_PORT || "27017");
// MQTT Settings
var mqtt_user = (process.env.MQTT_USER);
var mqtt_password = (process.env.MQTT_PASSWORD);
var mqtt_port = (process.env.MQTT_PORT || "1883");
var mqtt_url = (process.env.MQTT_URL || "mqtt://mosquitto:" + mqtt_port);
// Cookie Secret
var cookieSecret = (process.env.COOKIE_SECRET || 'ihytsrf334');
if (cookieSecret == 'ihytsrf334') {logger.log("warn", "[App] Using default Cookie Secret, please supply new secret using COOKIE_SECRET environment variable")}
else {logger.log("info", "[App] Using user-defined cookie secret")}
///////////////////////////////////////////////////////////////////////////
// Passport Configuration
///////////////////////////////////////////////////////////////////////////
passport.use(new LocalStrategy(Account.authenticate()));
passport.use(new BasicStrategy(Account.authenticate()));
passport.serializeUser(Account.serializeUser());
passport.deserializeUser(Account.deserializeUser());
///////////////////////////////////////////////////////////////////////////
// Main
///////////////////////////////////////////////////////////////////////////
// Check admin account exists, if not create it using same credentials as MQTT user/password supplied
Account.findOne({username: mqtt_user}, function(error, account){
	if (!error && !account) {
		Account.register(new Account({username: mqtt_user, email: '', mqttPass: '', superuser: 1}),
			mqtt_password, function(err, account){
			var topics = new Topics({topics: [
					'command/' +account.username+'/#', 
					'state/' + account.username + '/#',
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
								logger.log('error', err);
							}
						}
					);
				}
			});
		});
	} else {
		logger.log('info', "[App] Superuser MQTT account, " + mqtt_user + " already exists");
	}
});

var app = express();
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
	secret: cookieSecret,
	cookie: {
		secure: true
	}
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
app.use('/octicons', express.static('node_modules/@primer/octicons/build'), express.static('node_modules/@primer/octicons/build/svg')); // Octicons router

///////////////////////////////////////////////////////////////////////////
// Load Routes
///////////////////////////////////////////////////////////////////////////
const rtDefault = require('./routes/default'); 
const rtAdmin = require('./routes/admin'); 
const rtAuth = require('./routes/auth'); 
const rtGhome = require('./routes/ghome'); 
const rtAlexa = require('./routes/alexa'); 
app.use('/', rtDefault);
app.use('/admin', rtAdmin); // Admin Interface
app.use('/auth', rtAuth); // OAuth endpoints
app.use('/api/ghome', rtGhome); // Google Home API
app.use('/api/v1', rtAlexa); // Alexa API

var state = require('./state'); // Load State API

module.exports = app;




