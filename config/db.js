var mongoose = require('mongoose');
var logger = require('./logger'); // Moved to own module

// MongoDB Settings
var mongo_user = (process.env.MONGO_USER);
var mongo_password = (process.env.MONGO_PASSWORD);
var mongo_host = (process.env.MONGO_HOST || "mongodb");
var mongo_port = (process.env.MONGO_PORT || "27017");

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