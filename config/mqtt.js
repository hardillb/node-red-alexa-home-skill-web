var mqtt = require('mqtt');
var logger = require('./logger'); // Moved to own module

// MQTT Settings
var mqtt_user = (process.env.MQTT_USER);
var mqtt_password = (process.env.MQTT_PASSWORD);
var mqtt_port = (process.env.MQTT_PORT || "1883");
var mqtt_url = (process.env.MQTT_URL || "mqtt://mosquitto:" + mqtt_port);

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

logger.log('info', "[Core] Connecting to MQTT server: " + mqtt_url);
mqttClient = mqtt.connect(mqtt_url, mqttOptions);

mqttClient.on('error',function(err){
	logger.log('error', "[Core] MQTT connect error");
});

mqttClient.on('reconnect', function(){
	logger.log('warn', "[Core] MQTT reconnect event");
});

mqttClient.on('connect', function(){
	logger.log('info', "[Core] MQTT connected, subscribing to 'response/#'")
	mqttClient.subscribe('response/#');
	logger.log('info', "[Core] MQTT connected, subscribing to 'state/#'")
	mqttClient.subscribe('state/#');
});

module.exports = mqttClient;