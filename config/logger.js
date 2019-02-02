///////////////////////////////////////////////////////////////////////////
// Depends
///////////////////////////////////////////////////////////////////////////
const { format, createLogger, transports } = require('winston');
const fs = require('fs');
const WinstonCloudwatch = require('winston-cloudwatch');
const crypto = require('crypto');
///////////////////////////////////////////////////////////////////////////
// Variables
///////////////////////////////////////////////////////////////////////////
var debug = (process.env.ALEXA_DEBUG || false);
var awscredentials = '~/.aws/credentials'
var logGroup = (process.env.WEB_HOSTNAME || "node-red")
var startTime = new Date().toISOString();
if (debug == "true") {consoleLoglevel = "debug"};
///////////////////////////////////////////////////////////////////////////
// Exports
///////////////////////////////////////////////////////////////////////////
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
	]
  });
  // Create logger stream object for use with morgan
logger.stream = {
	write: function(message, encoding) {
	  // use the 'verbose' log level
	  logger.verbose(message);
	},
	};
	
// Check for AWS credentials
fs.access(awscredentials, fs.F_OK, (err) => {
	if (err) {
		logger.lof('warn', '[Logger] AWS credentials file does not exist at ~/.aws/credentials. Cludwatch logging disabled.');
		return
	}
	// Setup AWS CloudWatch Transport
	logger.add(new WinstonCloudwatch({
		level: consoleLoglevel,
		logGroupName: logGroup,
		logStreamName: function() {
			// Spread log streams across dates as the server stays up
			let date = new Date().toISOString().split('T')[0];
			return 'express-server-' + date + '-' +
				crypto.createHash('md5')
				.update(startTime)
				.digest('hex');
		},
		awsRegion: 'eu-west-1',
		jsonMessage: true
	}));
})

module.exports = logger;