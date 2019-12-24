///////////////////////////////////////////////////////////////////////////
// Depends
///////////////////////////////////////////////////////////////////////////
var logger = require('../logger'); // Moved to own module
///////////////////////////////////////////////////////////////////////////
// Redis Client Config
///////////////////////////////////////////////////////////////////////////
var client = require('redis').createClient({
    host: 'redis',
    db: 1,
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

module.exports = client;