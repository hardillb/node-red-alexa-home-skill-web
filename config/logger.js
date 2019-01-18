const { format, createLogger, transports } = require('winston');

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

  // Create logger stream object for use with morgan
logger.stream = {
	write: function(message, encoding) {
	  // use the 'verbose' log level
	  logger.verbose(message);
	},
  };

module.exports = logger;