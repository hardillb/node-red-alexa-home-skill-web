///////////////////////////////////////////////////////////////////////////
// Depends
///////////////////////////////////////////////////////////////////////////
var mongoose = require('mongoose');
var logger = require('./logger'); // Moved to own module
///////////////////////////////////////////////////////////////////////////
// Variables
///////////////////////////////////////////////////////////////////////////
// MongoDB Settings
var mongo_user = (process.env.MONGO_USER);
var mongo_password = (process.env.MONGO_PASSWORD);
var mongo_host = (process.env.MONGO_HOST || "mongodb");
var mongo_port = (process.env.MONGO_PORT || "27017");
mongo_url = "mongodb://" + mongo_user +":" + mongo_password + "@" + mongo_host + ":" + mongo_port + "/users";
mongoose.Promise = global.Promise;
var mongoose_connection = mongoose.connection;
///////////////////////////////////////////////////////////////////////////
// Connect to Mongo Instance
///////////////////////////////////////////////////////////////////////////
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

// Fix Mongoose Deprecation Warnings; https://mongoosejs.com/docs/deprecations.html
mongoose.set('useNewUrlParser', true);
mongoose.set('useCreateIndex', true);
mongoose.set('useFindAndModify', false);

// Move back to useUnifiedTopology: false
mongoose.set('useUnifiedTopology', true);

logger.log('info', "[Core] Connecting to MongoDB server: mongodb://" + mongo_host + ":" + mongo_port + "/users");

exports.connect = () => {
	mongoose.connect(mongo_url, {
		useNewUrlParser: true,
		useUnifiedTopology: true,
		poolSize: 10,
		socketTimeoutMS: 30000,
		keepAlive: true,
		keepAliveInitialDelay: 30000
	}).
		catch(error => logger.log('error', '[Core] Error connecting to MongoDB: ' + error));
}

// Move back to useUnifiedTopology: false
// exports.connect = () => {
// 	mongoose.connect(mongo_url, {
// 		useNewUrlParser: true,
// 		useUnifiedTopology: false,
// 		autoReconnect: true,
// 		reconnectTries: 30,
// 		reconnectInterval: 1000,
// 		poolSize: 15
// 	}).
// 		catch(error => logger.log('error', '[Core] Error connecting to MongoDB: ' + error));
// }