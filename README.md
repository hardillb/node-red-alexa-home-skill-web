# Node Red Alexa Home Skill v3
An Alexa Smart Home API v3 Skill for use with Node Red - enables the following Alexa native skills:
* Speaker (Step at time of writing)
* Playback Control (Play, Pause, Stop)
* Power Control (On/ Off)

Note there are 3 component parts to this service:
* This Web Application/ Associated Databases, Authentication and MQTT services
* An Amazon Lambda function (github repo link to follow for this fork)
* A Node-Red contrib (github repo link to follow for this fork)

At present *you* must deploy these component parts and update as outlined below. I'm working on hosting this in AWS shortly!

This project is based **extensively** on Ben Hardill's Alexa Smart Home API v2 project:
* https://github.com/hardillb/node-red-alexa-home-skill-web
* https://github.com/hardillb/node-red-alexa-home-skill-lambda
* https://github.com/hardillb/node-red-alexa-home-skill-web

# Service Architecture
| Layer | Product | Description |
|---------|-------|-----------|
|Database|Mongodb|users db contains all application data|
|Application|Mosquitto MQTT|With mosquitto-auth-plug|
|Application|Passport Authentication|Providing OAuth w/ Amazon for account linking|
|Application|AWS Lambda Function|Skill Endpoint|
|Web|NodeJS App|Provides web front end/ API endpoints for Lambda Function|
|Web|Node-Red Add-on|For acknowledgement of Alexa Commands/ integration into flows|

Collections under Mongodb users database:

| Collection| Purpose|
|--------|---------|
|accesstokens||
|accounts|Contains all user account information*|
|applications|Contains OAuth Service definitions|
|counters||
|devices|Contains all user devices|
|grantcodes||
|lostpasswords||
|refreshtokens||
|topics||

\* *Username/ email address and salted/ hashed password.*

It is assumed that MQTT will be behind a reverse proxy using TLS offload.

A NodeRed flow MUST be configured in order for Alexa commands to receive acknowledgement, i.e. you will get "Sorry, <device> is not responding."

## Service Accounts
WebApp mongodb account:
* **user home database**: user
* **account**: node-red-alexa
* **role**: readWrite on users db

MQTT mongodb account:
* **user home database**: admin
* **account**: node-red-alexa
* **role**: read on users db

## Data Flow
Alexa Skill --> Lambda --> 
* Discovery: Web App --> Lambda --> Alexa Skill
* Command: Web App --> MQTT (Cmd) --> Node Red Add-In --> MQTT (Ack)--> Web App --> Lambda --> Alexa Skill

# Environment Build

## MongoDB Container/ Account Creation
Docker image is used for mongo, with ```auth``` enabled.

Required user accounts are created automatically via docker-entrypoint-initdb.d script.
```
sudo mkdir -p /var/docker/mongodb/docker-entrypoint-initdb.d
sudo mkdir -p /var/docker/mongodb/etc
sudo mkdir -p /var/docker/mongodb/data

cd /var/docker/mongodb/docker-entrypoint-initdb.d
export MONGOADMIN=<username>
export MONGOPASSWORD=<password>
export MQTTUSER=<username>
export MQTTPASSWORD=<password>
export WEBUSER=<username>
export WEBPASSWORD=<password>

sudo wget -O mongodb-accounts.sh https://gist.github.com/coldfire84/93ae246f145ef09da682ee3a8e297ac8/raw/fb8c0f8e3f8294fa1333ae216322df9a58579778/mongodb-accounts.sh

sudo sed -i "s|<mongo-admin-user>|$MONGOADMIN|g" mongodb-accounts.sh
sudo sed -i "s|<mongo-admin-password>|$MONGOPASSWORD|g" mongodb-accounts.sh
sudo sed -i "s|<web-app-user>|$WEBUSER|g" mongodb-accounts.sh
sudo sed -i "s|<web-app-password>|$WEBPASSWORD|g" mongodb-accounts.sh
sudo sed -i "s|<mqtt-user>|$MQTTUSER|g" mongodb-accounts.sh
sudo sed -i "s|<mqtt-password>|$MQTTPASSWORD|g" mongodb-accounts.sh

sudo docker create \
--name mongodb -p 27017:27017 \
-e MONGO_INITDB_ROOT_USERNAME=$MONGOADMIN \
-e MONGO_INITDB_ROOT_PASSWORD=$MONGOPASSWORD \
-v /var/docker/mongodb/docker-entrypoint-initdb.d/:/docker-entrypoint-initdb.d/ \
-v /var/docker/mongodb/etc/:/etc/mongo/ \
-v /var/docker/mongodb/data/:/data/db/ \
mongo

sudo docker start mongod
```

## Mosquitto Container
A customer container is created using [mosquitto.dockerfile](mosquitto.dockerfile)
```
sudo docker build -t mosquitto-auth:0.1 -f mosquitto.dockerfile .
```
Then start the container:
```
sudo docker create --name mosquitto -p 1883:1883 mosquitto-auth:0.1
```

Again, this assumes you will proxy MQTT via NGINX/ similar with TLS offload.

## NodeJS WebApp Container
A customer container is created using [nodejs-webapp.dockerfile](nodejs-webapp.dockerfile)
```
mkdir nodejs-webapp
cd nodejs-webapp/
git clone https://github.com/coldfire84/node-red-alexa-home-skill-v3-web.git .
sudo docker build -t nr-alexav3-web:0.1 -f nodejs-webapp.dockerfile .
```
Then start the container:
```
export MQTT_URL=mqtt://<hostname/IP>
export MQTT_USER=<username>
export MQTT_PASSWORD=<password>
export MONGO_HOST=<hostname/IP>
export MONGO_PORT=<port>
export MONGO_USER=<username>
export MONGO_PASSWORD=<password>
export MAIL_SERVER=<hostname/IP>
export MAIL_USER=<username>
export MAIL_PASSWORD=<password>

sudo docker create \
--name nr-alexav3-webb \
-p 3000:3000 \
-e MQTT_URL=$MQTT_URL
-e MQTT_USER=$MQTT_USER
-e MQTT_PASSWORD=$MQTT_PASSWORD
-e MONGO_HOST=$MONGO_HOST
-e MONGO_PORT=$
-e MONGO_USER=$MONGO_USER
-e MONGO_PASSWORD=$MONGO_PASSWORD
-e MAIL_SERVER=$MAIL_SERVER
-e MAIL_USER=$MAIL_USER
-e MAIL_PASSWORD=$MAIL_PASSWORD
nr-alexav3-webb:0.1
```
Note it is assumed this web-app will be reverse proxied, i.e. HTTPS (NGINX) ---> 3000 (NodeJS)

| Env Variable | Purpose |
|--|--|
|MONGO_HOST|Mongodb Hostname/ IP that contains "users" db|
|MONGO_PORT|Mongodb port|
|MONGO_USER|User to connect to mongodb as|
|MONGO_PASSWORD|Password to connect to mongodb with|
|MQTT_URL|Mqtt server hostname/ ip address|
|MQTT_USER|User to connect to MQTT as|
|MQTT_PASSWORD|Password to connect to MQTT with|
|MAIL_SERVER|Mail server for sending out lost password/ reset emails|
|MAIL_USER|Mail server user account|
|MAIL_PASSWORD|Mail Server password|

## DNS/ Firewall/ HTTPS/ TLS
Decide where you'll host this web service, configure necessary DNS, firewall and certificate activites.

# Running the Service

## Dockerize NodeJS Web App
// Info to follow

## Configure Lambda Instance
// Info to follow

## Configure Alexa Skill
* Authorization URI: https://<hostname>/auth/start
* Access Token URI: https://<hostname>/auth/exchange
* Client ID: is generated by system automatically on creating a new service via https://<hostname>/admin/services (client id starts at 1, is auto incremented)
* Gather redirect URLs from ALexa Skill config, enter w/ comma separation 
* Client Secret: manually generated numerical (yes, *numerical only*) i.e. 6600218816767991872626
* Client Authentication Scheme: Credentials in request body
* Scopes: access_devices and create_devices
* Domain List: <hostname used to publish web service>

# Management

## Adding Support for Alexa Device Type

### Lambda Function Changes
Extend command directive to include new namespace (line 10+):
```
// Add options to include other directives
else if (event.directive.header.namespace === 'Alexa.PowerController' || event.directive.header.namespace === 'Alexa.PlaybackController') {
    command(event,context, callback);
```
Modify the command function to include necessary response for namespace:
```
// Build PowerController Response Context
if (namespace == "Alexa.PowerController") {
    if (name == "TurnOn") {var newState = "ON"};
    if (name == "TurnOff") {var newState = "OFF"};
    var contextResult = {
        "properties": [{
            "namespace": "Alexa.PowerController",
            "name": "powerState",
            "value": newState,
            "timeOfSample": dt.toISOString(),
            "uncertaintyInMilliseconds": 50
        }]
    };
}

// Build PlaybackController Response Context
if (namespace == "Alexa.PlaybackController") {
    var contextResult = {
        "properties": []
    };
}
```

Update Lambda code/ save on AWS.

### Web Service Changes
Modify replaceCapability function to include necessary discovery response, for example:
```
	if(capability == "PowerController") {
		return [{
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
			}];
	}
```
Modify views/pages/devices.ejs to include new checkbox for category

Modify views/pages/devices.ejs checkCapability function to include necessary logic to:
* Assign correct icon
* Prohibit additional selections

Create 60x40 icon, with the same name as capability checkbox id/ value.

Update nodejs server via git pull/ restart nodejs application.

### Node-Red-Contrib Changes
Review     function alexaHome(n), specifically switch statement:
```
// Needs expanding based on additional applications
switch(message.directive.header.name){
    case "TurnOn":
        // Power-on command
        msg.payload = true;
        break;
    case "TurnOff":
        // Power-off command
        msg.payload = false;
        break;
    case "AdjustVolume":
        // Volume adjustment command
        msg.payload = message.directive.payload.volumeSteps;
        break;
}
```

## MQTT
Test MQTT events are being received for a specific user:
```
mosquitto_sub -h <mqtt-server> --username '<username>' --pw '<password>' -t command/<username>/# -i test_client
```

## Databases

### Remove a Database
```
mongod
show dbs
use users
db.dropDatabase()
```

### View Collections
```
mongod
show dbs
use users
show collections
```

## Change Mongodb User Password
```
db.changeUserPassword("<username>", "<new password>")
```
### Rmemove Mongodb User
```
use admin
db.dropUser("mqtt-user")
```

# Useful Links
* https://gist.github.com/hardillb/0ce50250d40ff6fc3d623ddb5926ec4d
* https://github.com/hardillb/node-red-contrib-alexa-home-skill
* https://github.com/hardillb/node-red-alexa-home-skill-lambda
* https://github.com/hardillb/node-red-alexa-home-skill-web
* https://github.com/hardillb/alexa-oauth-test