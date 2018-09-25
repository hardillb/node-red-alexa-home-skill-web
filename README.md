# Node Red Alexa Home Skill v3
An Alexa Smart Home API v3 Skill for use with Node Red - enables any combination* of the following Alexa native skills:

|Alexa Interface|Supported Controls|Example Usage|Useful Links|
|--------|----------|-------------|-------------|
|Input Control|HDMI1,HDMI2,HDMI3,HDMI4,phono,audio1,audio2 and "chromecast"|Yamaha Music Cast Amplifier|[node-red-contrib-avr-yamaha](https://flows.nodered.org/node/node-red-contrib-avr-yamaha)|
|Playback Control|Play, Pause, Stop|Kodi RPC|Http Response Node with [Kodi RPC Commands](https://kodi.wiki/view/JSON-RPC_API/Examples)|
|Power Control|On, Off|MQTT Out|Any MQTT-enabled switch, Socket etc|
|Scene Control|Turn On|Multiple|String together a number of nodes for your scene, i.e. lighting, TV on, ACR on|
|Speaker (Step)|+/- volume|Yamaha Music Cast Amplifier|[node-red-contrib-avr-yamaha](https://flows.nodered.org/node/node-red-contrib-avr-yamaha)|
|Thermostats Control (Single setpoint only)|Set specific temp, increase/ decrease|Any MQTT connected thermostat/HVAC|-|

\* *Scene Control and Thermostat Control cannot co-exist with other capabilities.*

Note there are 3 component parts to this service:
* This Web Application/ Associated Databases, Authentication and MQTT services
* An [Amazon Lambda](https://github.com/coldfire84/node-red-alexa-home-skill-v3-lambda) function
* A [Node-Red contrib](https://github.com/coldfire84/node-red-contrib-alexa-home-skill-v3)

At present this skill is pre-production, but I can extend it to you (alternatively deploy the component parts!).

This project is based **extensively** on Ben Hardill's Alexa Smart Home API v2 project:
* https://github.com/hardillb/node-red-alexa-home-skill-web
* https://github.com/hardillb/node-red-alexa-home-skill-lambda
* https://github.com/hardillb/node-red-alexa-home-skill-web

To "migrate" from this service to v3 see section title **Service Migration**.

# Service Architecture
| Layer | Product | Description |
|---------|-------|-----------|
|Database|Mongodb|users db contains all application data|
|Database|Mongodb|sessions db contains all webapp session data|
|Application|Mosquitto MQTT|With mosquitto-auth-plug|
|Application|Passport Authentication|Providing OAuth w/ Amazon for account linking|
|Application|AWS Lambda Function|Skill Endpoint|
|Web|NodeJS App|Provides web front end/ API endpoints for Lambda Function|
|Web|Node-Red Add-on|For acknowledgement of Alexa Commands/ integration into flows|
|Web|NGINX|Reverse Proxy for NodeJS Application|

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

A NodeRed flow MUST be configured in order for Alexa commands to receive acknowledgement, i.e. you will get "Sorry, <device> is not responding."

## Docker Containers
MongoDB and Mosquitto container names are **criticial** for deployment to be successful. Containers reside on a user defined docker network which provides DNS resolution via container name.

|Container Name|Service|Ports|
|---|---|---|
|mongodb|MongoDB Server|TCP 27017|
|mosquitto|Mopsquitto Server|TCP 1883:1883*, 8338:8338|
|nr-alexav3-web|Node.JS App|TCP 3000:3000|
|nginx|NGINX Proxy|TCP 443:443, 80:80|

\* *Note that 1883 is only available within hosting environment, 8338 is only available via Internet-based devices.

## Service Accounts
WebApp mongodb account:
* **user home database**: user
* **account**: node-red-alexa
* **role**: readWrite on users db

WebApp mongodb account:
* **user home database**: user
* **account**: node-red-alexa
* **role**: dbOwenr on sessions db

MQTT mongodb account:
* **user home database**: admin
* **account**: node-red-alexa
* **role**: read on users db

## Data Flow
Alexa Skill --> Lambda --> 
* Discovery: Web App --> Lambda --> Alexa Skill
* Command: Web App --> MQTT (Cmd) --> Node Red Add-In --> MQTT (Ack)--> Web App --> Lambda --> Alexa Skill

# Environment Build

## Create Docker Network
```
sudo docker network create nr-alexav3
```

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

sudo wget -O mongodb-accounts.sh https://gist.github.com/coldfire84/93ae246f145ef09da682ee3a8e297ac8/raw/7b66fc4c4821703b85902c85b9e9a31dc875b066/mongodb-accounts.sh
sudo chmod +x mongodb-accounts.sh

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
## Certificate
We will use the same SSL certificate to protect the NodeJS and MQTT services.

Ensure that your hosting solution has HTTPS connectivity enabled.

We'll use certbot to request a free certificate:
```
sudo docker run -it --rm \
--name letsencrypt \
--p 80:80 -p 443:443 \
-v "/var/docker/ssl/:/etc/letsencrypt" \
certbot/certbot \
certonly \
--preferred-challenges http \
--standalone \
--agree-tos \
--renew-by-default \
-d <FQDN of web app> \
--email <your email address>
```
## Mosquitto Container
A customer container is created using [mosquitto.dockerfile](mosquitto.dockerfile)
```
sudo docker build -t mosquitto-auth:0.1 -f mosquitto.dockerfile .
sudo mkdir -p /var/docker/mosquitto/config/conf.d
sudo mkdir -p /var/docker/mosquitto/data

cd /var/docker/mosquitto/config
wget -O mosquitto.conf https://gist.github.com/coldfire84/9f497c131d80763f5bd8408762581fe6/raw/9a9fd7790e4edb5f0129e9a5ff0bd7449b43dffd/mosquitto.conf

cd /var/docker/mosquitto/config/conf.d/
wget -O node-red-alexa-smart-home-v3.conf https://gist.github.com/coldfire84/51eb34808e2066f866e6cc26fe481fc0/raw/88b69fd7392612d4be968501747c138e54391fe4/node-red-alexa-smart-home-v3.conf

export DNS_HOSTNAME=<IP/ hostname yused for SSL Certs>
export MONGO_SERVER=mongodb
export MQTTUSER=<username>
export MQTTPASSWORD=<password>

sudo sed -i "s/<mongo-server>/$MONGO_SERVER/g" node-red-alexa-smart-home-v3.conf
sudo sed -i "s/<user>/$MQTTUSER/g" node-red-alexa-smart-home-v3.conf
sudo sed -i "s/<password>/$MQTTPASSWORD/g" node-red-alexa-smart-home-v3.conf
sudo sed -i "s/<dns-hostname>/$DNS_HOSTNAME/g" node-red-alexa-smart-home-v3.conf

```
Then start the container:
```
sudo docker create --name mosquitto \
--network nr-alexav3 \
-p 1883:1883 \
-p 8883:8883 \
-v /var/docker/ssl:/etc/letsencrypt \
-v /var/docker/mosquitto/config:/mosquitto/config \
-v /var/docker/mosquitto/data:/mosquitto/data \
mosquitto-auth:0.1
```

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
export WEB_HOSTNAME=<hostname/IP>
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
-p 443:3000 \
-v /var/docker/ssl:/etc/letsencrypt \
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

## Nginx 

```
cd ~
mkdir ngix
git clone https://github.com/coldfire84/node-red-alexa-home-skill-v3-web.git .

sudo mkdir -p /var/docker/nginx/conf.d
sudo mkdir -p /var/docker/nginx/stream_conf.d
sudo mkdir -p /var/docker/nginx/includes
sudo mkdir -p /var/docker/nginx/www

# Get Config Files
wget -O /var/docker/nginx/conf.d/default.conf 
https://gist.github.com/coldfire84/47f90bb19a91f218717e0b7632040970/raw/65bb04af575ab637fa279faef03444f2525793db/default.conf

wget -O /var/docker/nginx/includes/header.conf https://gist.github.com/coldfire84/47f90bb19a91f218717e0b7632040970/raw/65bb04af575ab637fa279faef03444f2525793db/header.conf

wget -O /var/docker/nginx/includes/letsencrypt.conf https://gist.github.com/coldfire84/47f90bb19a91f218717e0b7632040970/raw/65bb04af575ab637fa279faef03444f2525793db/letsencrypt.conf

wget -O /var/docker/nginx/conf.d/nr-alexav3.cb-net.co.uk.conf https://gist.github.com/coldfire84/47f90bb19a91f218717e0b7632040970/raw/65bb04af575ab637fa279faef03444f2525793db/nr-alexav3.cb-net.co.uk.conf

wget -O /var/docker/nginx/includes/restrictions.conf https://gist.github.com/coldfire84/47f90bb19a91f218717e0b7632040970/raw/65bb04af575ab637fa279faef03444f2525793db/restrictions.conf

wget -O /var/docker/nginx/includes/ssl-params.conf https://gist.github.com/coldfire84/47f90bb19a91f218717e0b7632040970/raw/65bb04af575ab637fa279faef03444f2525793db/ssl-params.conf

if [ ! -f /var/docker/ssl/dhparams.pem ]; then
    sudo openssl dhparam -out /var/docker/ssl/dhparams.pem 2048
fi

sudo docker run --net nr-alexav3 --name nginx -p 80:80 -p 443:443 \
-v /var/docker/nginx/conf.d/:/etc/nginx/conf.d/ \
-v /var/docker/nginx/stream_conf.d/:/etc/nginx/stream_conf.d/ \
-v /var/docker/ssl:/etc/nginx/ssl/ \
-v /var/docker/nginx/includes:/etc/nginx/includes/ \
-v /var/docker/nginx/www/:/var/www \
--restart always \
-d nginx
```

## Create and Configure Lambda Function
Create a new AWS Lambda function in either of:
* eu-west-1
* us-east-1

Upload [index.js](https://github.com/coldfire84/node-red-alexa-home-skill-v3-lambda/blob/master/index.js) from the [node-red-alexa-home-skill-v3-lambda](https://github.com/coldfire84/node-red-alexa-home-skill-v3-lambda) repo.

Set options as below:
* **Runtime**: Node.js 6.10
* **Handler**: index.handler

From the top right of the Lambda console, copy the "ARN", i.e. arn:aws:lambda:eu-west-1:<number>:function:node-red-alexa-smart-home-v3-lambda - you will need this for the Alexa skill definition.

## Create and Configure the Alexa Skill
* Authorization URI: https://<hostname>/auth/start
* Access Token URI: https://<hostname>/auth/exchange
* Client ID: is generated by system automatically on creating a new service via https://<hostname>/admin/services (client id starts at 1, is auto incremented)
* Gather redirect URLs from ALexa Skill config, enter w/ comma separation 
* Client Secret: manually generated numerical (yes, *numerical only*) i.e. 6600218816767991872626
* Client Authentication Scheme: Credentials in request body
* Scopes: access_devices and create_devices
* Domain List: <hostname used to publish web service>

## DNS/ Firewall/ HTTPS/ TLS
Decide where you'll host this web service, configure necessary DNS, firewall and certificate activities.

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