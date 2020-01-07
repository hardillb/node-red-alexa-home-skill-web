///////////////////////////////////////////////////////////////////////////
// Depends
///////////////////////////////////////////////////////////////////////////
var dotenv = require('dotenv').config();
var favicon = require('serve-favicon')
var flash = require('connect-flash');
var morgan = require('morgan');
var express = require('express');
const session = require('express-session');
const mongoStore = require('connect-mongo')(session);
var passport = require('passport');
var bodyParser = require('body-parser');
const path = require('path');
const { SitemapStream, streamToPromise } = require('sitemap');
const { createGzip } = require('zlib');
const robots = require('express-robots-txt');
///////////////////////////////////////////////////////////////////////////
// Loaders/ Services
///////////////////////////////////////////////////////////////////////////
var db = require('./loaders/db'); // Load DB module, note connect happens later
var mqtt = require('./loaders/mqtt'); // Load MQTT client and connect
var state = require('./services/state'); // Load State API
///////////////////////////////////////////////////////////////////////////
// Schema
///////////////////////////////////////////////////////////////////////////
var Account = require('./models/account');
var oauthModels = require('./models/oauth');
var passport = require('passport');
var BasicStrategy = require('passport-http').BasicStrategy;
var LocalStrategy = require('passport-local').Strategy;
var PassportOAuthBearer = require('passport-http-bearer');
var logger = require('./loaders/logger');
///////////////////////////////////////////////////////////////////////////
// External Functions
///////////////////////////////////////////////////////////////////////////
const createACL = require('./services/func-services').createACL;
const setupServiceAccount = require('./services/func-services').setupServiceAccount;
///////////////////////////////////////////////////////////////////////////
// Variables
///////////////////////////////////////////////////////////////////////////
// MongoDB Settings, used for express session handler DB connection
var mongo_user = (process.env.MONGO_USER);
var mongo_password = (process.env.MONGO_PASSWORD);
var mongo_host = (process.env.MONGO_HOST || "mongodb");
var mongo_port = (process.env.MONGO_PORT || "27017");
// MQTT Settings
var mqtt_user = (process.env.MQTT_USER);
var mqtt_password = (process.env.MQTT_PASSWORD);
// Cookie Secret
var cookieSecret = (process.env.COOKIE_SECRET || 'ihytsrf334');
if (cookieSecret == 'ihytsrf334') {logger.log("warn", "[App] Using default Cookie Secret, please supply new secret using COOKIE_SECRET environment variable")}
else {logger.log("info", "[App] Using user-defined cookie secret")}
///////////////////////////////////////////////////////////////////////////
// Passport Configuration
///////////////////////////////////////////////////////////////////////////
// Configure Passport Local Strategy via createStrategy() helper method, as-per https://www.npmjs.com/package/passport-local-mongoose#simplified-passportpassport-local-configuration
passport.use(Account.createStrategy());
// Create Passport Basic Strategy
passport.use(new BasicStrategy(Account.authenticate()));
passport.serializeUser(Account.serializeUser());
passport.deserializeUser(Account.deserializeUser());
///////////////////////////////////////////////////////////////////////////
// Main
///////////////////////////////////////////////////////////////////////////
// *****
// Pre-flight checks
// *****
// Validate dotenv was successful
if (dotenv.error) {
	logger.log('error',"[Core] dotenv parsing failed, please ensure you have mapped .env file to /usr/src/app/.env, an example file is provided, see .env.template for more information");
	throw dotenv.error;
}
// Validate CRITICAL environment variables passed to container
if (!(process.env.MONGO_USER && process.env.MONGO_PASSWORD && process.env.MQTT_USER && process.env.MQTT_PASSWORD && process.env.MQTT_PORT)) {
	logger.log('error',"[Core] You MUST supply MONGO_USER, MONGO_PASSWORD, MQTT_USER, MQTT_PASSWORD and MQTT_PORT environment variables");
	process.exit(1);
}
// Validate BRAND environment variables passed to container
if (!(process.env.BRAND)) {
	logger.log('error',"[Core] You MUST supply BRAND environment variable");
	process.exit(1);
}
// Warn on not supply of MONGO/ MQTT host names
if (!(process.env.MONGO_HOST && process.env.MQTT_URL)) {
	logger.log('warn',"[Core] Using 'mongodb' for Mongodb and 'mosquitto' for MQTT service endpoints, no MONGO_HOST/ MQTT_URL environment variable supplied");
}
// Warn on not supply of MAIL username/ password/ server
if (!(process.env.MAIL_SERVER && process.env.MAIL_USER && process.env.MAIL_PASSWORD)) {
	logger.log('warn',"[Core] No MAIL_SERVER/ MAIL_USER/ MAIL_PASSWORD environment variable supplied. System generated emails will generate errors");
}
// Warn on SYNC_API not being specified/ request SYNC will be disabled
if (!(process.env.HOMEGRAPH_APIKEY)){
	logger.log('warn',"[Core] No HOMEGRAPH_APIKEY environment variable supplied. New devices, removal or device changes will not show in users Google Home App without this");
}
// *****
// Create server itself
// *****
const createServer = async() => {
	try {
		// Connect to MongoDB
		db.connect();
		// Setup superuser / service account
		var boolSetupServiceAccount = await setupServiceAccount(mqtt_user, mqtt_password);
		// Superuser setup failed, exit
		if (boolSetupServiceAccount == false) process.exit(1);
		// Create MQTT ACLs
		let arrayACLs = ['command/%u/#','message/%u/#','state/%u/#','response/%u/#'];
		let errACLs = false;
		for (let acl of arrayACLs) {
			var topic = await createACL(acl);
			if (topic == undefined) errACLs = true;
		}
		// If ACL creation fails API will not function, exit
		if (errACLs == true) process.exit(1);
		// Create Express instance
		var app = express();
		app.set('view engine', 'ejs');
		app.enable('trust proxy');
		app.use(favicon(path.join(__dirname, '/interfaces/static', 'favicon.ico')))
		// Configure logging
		app.use(morgan("combined", {stream: logger.stream})); // change to use Winston
		// Enable req.flash support
		app.use(flash());
		// Setup session handler
		app.use(session({
			store: new mongoStore({
				url: "mongodb://" + mongo_user +":" + mongo_password + "@" + mongo_host + ":" + mongo_port + "/sessions"
			}),
			resave: true,
			saveUninitialized: false,
			secret: cookieSecret,
			cookie: {
				secure: true
			}
		}));
		app.use(bodyParser.json());
		app.use(bodyParser.urlencoded({ extended: false }));
		app.use(passport.initialize());
		app.use(passport.session());
		// Set EJS views template path
		app.set('views', path.join(__dirname, 'interfaces/views/'));
		// Configure static content
		app.use('/static', express.static(path.join(__dirname, '/interfaces/static')));
		app.use('/static/octicons', express.static('node_modules/@primer/octicons/build'), express.static('node_modules/@primer/octicons/build/svg')); // Octicons router
		// Setup robots.txt
		app.use(robots({UserAgent: '*', Allow: '/', CrawlDelay: '5', Sitemap: 'https://' + process.env.WEB_HOSTNAME + '/sitemap.xml'}))
		// Setup site map, based on example here: https://www.npmjs.com/package/sitemap#example-of-using-sitemapjs-with-express
		let sitemap
		app.get('/sitemap.xml', function(req, res) {
			res.header('Content-Type', 'application/xml');
			res.header('Content-Encoding', 'gzip');
			// if we have a cached entry send it
			if (sitemap) {
				res.send(sitemap)
				return
			}
			try {
				const smStream = new SitemapStream({ hostname: 'https://' + process.env.WEB_HOSTNAME + '/' })
				const pipeline = smStream.pipe(createGzip())
				smStream.write({ url: '/',  changefreq: 'weekly', priority: 0.5 })
				smStream.write({ url: '/about/',  changefreq: 'weekly',  priority: 0.5})
				smStream.write({ url: '/docs',  changefreq: 'weekly',  priority: 0.5 })
				smStream.write({ url: '/login/',  changefreq: 'monthly',  priority: 0.3})
				smStream.write({ url: '/new-user/',  changefreq: 'monthly',  priority: 0.3})
				smStream.write({ url: '/privacy/',  changefreq: 'monthly',  priority: 0.3})
				smStream.write({ url: '/tos/',  changefreq: 'monthly',  priority: 0.3})
				smStream.end()
				// cache the response
				streamToPromise(pipeline).then(sm => sitemap = sm)
				// stream the response
				pipeline.pipe(res).on('error', (e) => {throw e})
			} catch (e) {
				console.error(e)
				res.status(500).end()
			}
		});
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
		///////////////////////////////////////////////////////////////////////////
		// Passport Configuration
		///////////////////////////////////////////////////////////////////////////
		passport.use(new LocalStrategy(Account.authenticate()));
		passport.use(new BasicStrategy(Account.authenticate()));

		passport.serializeUser(Account.serializeUser());
		passport.deserializeUser(Account.deserializeUser());
		var accessTokenStrategy = new PassportOAuthBearer(function(token, done) {
			oauthModels.AccessToken.findOne({ token: token }).populate('user').populate('grant').exec(function(error, token) {
				if (!error && token) {
					logger.log('debug', "[OAuth] Returned OAuth Token: " + JSON.stringify(token));
					// Check token is active, has a grant, grant is active, has use and user is active
					if (token.active && token.grant && token.grant.active && token.user && token.user.active) {
						logger.log('verbose', "[OAuth] OAuth Token success for user: " + token.user.username + ", token: " + JSON.stringify(token));
						done(null, token.user, { scope: token.scope });
					}
					// Found OAuth token, however token not active
					else if (!token.active) {
						logger.log('warn', "[OAuth] OAuth Token failure, token not active: " + JSON.stringify(token));
						done(null, false);
					}
					// Found OAuth token, however token has no grant
					else if (!token.grant) {
						logger.log('warn', "[OAuth] OAuth Token failure, missing grant token: " + JSON.stringify(token));
						done(null, false);
					}
					// Found OAuth token, however token grant not active
					else if (!token.grant.active) {
						logger.log('warn', "[OAuth] OAuth Token failure, grant token not active: " + JSON.stringify(token));
						done(null, false);
					}
					// Found OAuth token, however token user missing (should never get here!)
					else if (!token.user) {
						logger.log('warn', "[OAuth] OAuth Token failure, user population failed: " + JSON.stringify(token));
						done(null, false);
					}
					// Found OAuth token, however user is not active/ enabled
					else if (token.user && token.user.active == false) {
						logger.log('warn', "[OAuth] OAuth Token failure, user: " + token.user.username + ", user.active is false");
						done(null, false);
					}
				}
				// No OAuth token found
				else if (!token) {
					logger.log('warn', "[OAuth] OAuth Token failure, token not found for user!");
					done(null, false);
				}
				// An Error occurred in trying to find OAuth token
				else {
					logger.log('error', "[OAuth] OAuth Token lookup failed, error: " + error);
					done(error);
				}
			});
		});

		passport.use(accessTokenStrategy);

		///////////////////////////////////////////////////////////////////////////
		// Error Handler
		///////////////////////////////////////////////////////////////////////////

		// 404 Handler
		app.use(function(req, res, next) {
			const err = new Error('Not Found');
			err.status = 404;
			next(err);
		});
		// Error Handler
		app.use(function(err, req, res, next) {
			res.status(err.status || 500).send(err.message);
			if (err.status == 404){
				logger.log('warn', "[App] Not found: " + err.status + ", path: " + req.path);
			}
			else {
				logger.log('error', "[App] Fall-back error handler, status code: " + err.status + ", message: " + err.message);
			}
		});

		// NodeJS App Settings
		var port = (process.env.VCAP_APP_PORT || 3000);
		var host = (process.env.VCAP_APP_HOST || '0.0.0.0');
		// Express Settings
		if (process.env.VCAP_APPLICATION) {
			var application = JSON.parse(process.env.VCAP_APPLICATION);
			var app_uri = application['application_uris'][0];
			app_id = 'https://' + app_uri;
		}
		else {
			//var app_id = 'http://localhost:' + port;
			var app_uri = (process.env.WEB_HOSTNAME || 'localhost');
			var app_id = 'https://' + app_uri;
		}
		// Create HTTP Server, to be proxied
		var server = app.listen(port, function(){
			logger.log('info', "[Core] App listening on: " + host + ":" + port);
			logger.log('info', "[Core] App_ID -> " + app_id);
		});
		// Set timeout to 5 seconds
		server.setTimeout = 5000;
	}
	catch(e){
		logger.log('error', "[App] Create Server catch error handler, error: " + e.stack);
	}
}

createServer();