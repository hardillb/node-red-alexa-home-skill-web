**********
Deploy Your Own
**********

.. warning:: This is for advanced users/ scenarios only, with the free to use :ref:`hosted instance <getting-started>`. you can be up and running in just a few minutes.

Pre-Requisites
***************
To deploy your own instance you are going to need:

1. A cloud-based Linux server (this guide assumes Ubuntu server)
2. An AWS account where you can run Lambda instances
3. An email service that supports programmatic sending/ receiving of email
4. A registered domain
5. A CloudFlare account, configured to perform DNS for your registered domain

You will require two DNS host names/ A records to be defined for the API and MQTT service:
1. Web interface/ API - where you/ your users will login and define their devices
2. MQTT service

These should be separate A records to enable caching/ security functionality via CloudFlare - you cannot route MQTT traffic through the CloudFlare security platform.

.. tip:: You can of course choose to run your environment differently, if you will have to workout how to modify the setup instructions accordingly.

Define Service Accounts
***************
You need to define three user accounts/ passwords:

1. MongoDB admin account
2. MongoDB account for the API to connect to the database
3. Superuser account for the API to connect with to the MQTT server/ your admin account for the Web API

Define these as environment variables to make container setup easier::

    export MONGO_ADMIN=<username>
    export MONGO_PASSWORD=<password>
    export MQTT_USER=<username>
    export MQTT_PASSWORD=<password>
    export WEB_USER=<username>
    export WEB_PASSWORD=<password>

These will also be copied into a .env file later in the deployment process.

.. warning:: Once the API is setup you should clear your shell history.

.. _docker:

Install Docker CE
***************
For Ubuntu 18.04 follow `this Digital Ocean guide. <https://www.digitalocean.com/community/tutorials/how-to-install-and-use-docker-on-ubuntu-18-04>`_

Summarised version::

    sudo apt install apt-transport-https ca-certificates curl software-properties-common
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo apt-key add -
    sudo add-apt-repository "deb [arch=amd64] https://download.docker.com/linux/ubuntu bionic stable"
    sudo apt update
    sudo apt install docker-ce

.. note:: These instructions are specifically designed for use on Ubuntu 18.04.

Create Docker Network
***************
To isolate our application from other Docker workloads we will create a dedicated Docker network::

    sudo docker network create nr-alexav3

MongoDB Container/ Account Creation
***************
Docker image is used for mongo, with auth enabled.

API-required user accounts are created automatically via docker-entrypoint-initdb.d script, use the following commands to setup the MongoDB database (modifying the environment variables to suit)::

    sudo mkdir -p /var/docker/mongodb/docker-entrypoint-initdb.d
    sudo mkdir -p /var/docker/mongodb/etc
    sudo mkdir -p /var/docker/mongodb/data
    cd /var/docker/mongodb/docker-entrypoint-initdb.d

    sudo wget -O mongodb-accounts.sh https://gist.github.com/coldfire84/93ae246f145ef09da682ee3a8e297ac8/raw/7b66fc4c4821703b85902c85b9e9a31dc875b066/mongodb-accounts.sh
    sudo chmod +x mongodb-accounts.sh

    sudo sed -i "s|<mongo-admin-user>|$MONGO_ADMIN|g" mongodb-accounts.sh
    sudo sed -i "s|<mongo-admin-password>|$MONGO_PASSWORD|g" mongodb-accounts.sh
    sudo sed -i "s|<web-app-user>|$WEB_USER|g" mongodb-accounts.sh
    sudo sed -i "s|<web-app-password>|$WEB_PASSWORD|g" mongodb-accounts.sh
    sudo sed -i "s|<mqtt-user>|$MQTT_USER|g" mongodb-accounts.sh
    sudo sed -i "s|<mqtt-password>|$MQTT_PASSWORD|g" mongodb-accounts.sh

    sudo docker create \
    --name mongodb -p 27017:27017 \
    --network nr-alexav3 \
    -e MONGO_INITDB_ROOT_USERNAME=$MONGO_ADMIN \
    -e MONGO_INITDB_ROOT_PASSWORD=$MONGO_PASSWORD \
    -v /var/docker/mongodb/docker-entrypoint-initdb.d/:/docker-entrypoint-initdb.d/ \
    -v /var/docker/mongodb/etc/:/etc/mongo/ \
    -v /var/docker/mongodb/data/:/data/db/ \
    -v /var/docker/backup:/backup/ \
    --log-opt max-size=100m \
    --log-opt max-file=5 \
    mongo

    sudo docker start mongodb

On first launch the init script should run, creating all of the required MongoDB users, as outlined above.

The credentials defined under WEB_USER/ WEB_PASSWORD are your superuser account, required for setting up OAuth in the Web Service.

Certificates
***************
We will use the same SSL certificate to protect the NodeJS and MQTT services. Ensure that, before running these commands, your hosting solution has HTTPS connectivity enabled.

We'll use certbot to request a free certificate for the Web App, and its integration with CloudFlare.

First, install certbot::

    sudo add-apt-repository ppa:certbot/certbot
    sudo apt-get update
    sudo apt-get install python3-certbot-dns-cloudflare

Create cloudflare.ini file under /home/username/.secrets/cloudflare.ini::

    # Cloudflare API credentials used by Certbot
    dns_cloudflare_email = <cloudflare email address>
    dns_cloudflare_api_key = <cloudflare API key>

Request your certificates::

    sudo certbot certonly \
    --agree-tos \
    --renew-by-default \
    --dns-cloudflare \
    --dns-cloudflare-credentials <path to cloudflare.ini> \
    --dns-cloudflare-propagation-seconds 60 \
    -d <fqdn of web API> \
    --email <your email address>

    sudo certbot certonly \
    --agree-tos \
    --renew-by-default \
    --dns-cloudflare \
    --dns-cloudflare-credentials <path to cloudflare.ini> \
    --dns-cloudflare-propagation-seconds 60 \
    -d <fqdn of MQTT> \
    --email <your email address>

Renewals will be handled automatically by certbot, but we will need to configure a script to run on renewal that sends a SIGHUP to NGINX and a restart to mosquitto. We have to restart Mosquitto as it will not reload the TLS certificate on SIGHUP, see here::

    sudo vi /etc/letsencrypt/renewal-hooks/deploy/reload-containers.sh

Now paste the following contents into this script::

    #!/bin/bash
    docker kill --signal=HUP nginx
    docker restart mosquitto
    Finally, make this script executable:

    sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-containers.sh

Mosquitto Container
***************
A custom mosquitto/ mosquitto-auth-plug container is used in this deployment::

    sudo mkdir -p /var/docker/mosquitto/config/conf.d
    sudo mkdir -p /var/docker/mosquitto/data
    sudo mkdir -p /var/docker/mosquitto/log
    sudo chown -R 1883:1883 /var/docker/mosquitto/config
    sudo chown -R 1883:1883 /var/docker/mosquitto/data
    sudo chown -R 1883:1883 /var/docker/mosquitto/log

    cd /var/docker/mosquitto/config
    sudo wget -O mosquitto.conf https://gist.githubusercontent.com/coldfire84/9f497c131d80763f5bd8408762581fe6/raw/e656ca5ace3a4183dfa6f7bcbcb8acb9c16c0438/mosquitto.conf

    cd /var/docker/mosquitto/config/conf.d/
    sudo wget -O node-red-alexa-smart-home-v3.conf https://gist.github.com/coldfire84/51eb34808e2066f866e6cc26fe481fc0/raw/88b69fd7392612d4be968501747c138e54391fe4/node-red-alexa-smart-home-v3.conf

    export MQTT_DNS_HOSTNAME=<IP/ hostname used for SSL Certs>
    export MONGO_SERVER=<mongodb container name>
    export MQTT_USER=<username>
    export MQTT_PASSWORD=<password>

    sudo sed -i "s/<mongo-server>/$MONGO_SERVER/g" node-red-alexa-smart-home-v3.conf
    sudo sed -i "s/<user>/$MQTT_USER/g" node-red-alexa-smart-home-v3.conf
    sudo sed -i "s/<password>/$MQTT_PASSWORD/g" node-red-alexa-smart-home-v3.conf
    sudo sed -i "s/<dns-hostname>/$MQTT_DNS_HOSTNAME/g" node-red-alexa-smart-home-v3.conf
    sudo sed -i "s|/usr/local/src|/usr/local/lib|g" node-red-alexa-smart-home-v3.conf

Then start the container::

    sudo docker create --name mosquitto \
    --network nr-alexav3 \
    -p 1883:1883 \
    -p 8883:8883 \
    -v /etc/letsencrypt:/etc/letsencrypt \
    -v /var/docker/mosquitto/config:/mosquitto/config \
    -v /var/docker/mosquitto/data:/mosquitto/data \
    -v /var/docker/mosquitto/log:/mosquitto/log \
    --restart=always \
    --log-opt max-size=10m \
    --log-opt max-file=5 \
    coldfire84/mosquitto-auth:development

.. note:: A custom container is used as it includes the `mosquitto-auth-plug <https://github.com/jpmens/mosquitto-auth-plug>`_

Redis Container
***************
Create the required Redis server container::

    sudo mkdir -p /var/docker/redis/data
    sudo docker create --name redis \
    --network nr-alexav3 \
    -v /var/docker/redis/data:/data \
    --restart always \
    --log-opt max-size=10m \
    --log-opt max-file=5 \
    redis

.. note:: Redis is used by express-limiter

NodeJS WebApp Container
***************
Now it's time to build/ deploy the Web API itself.

Create Google Home Graph JWT
---------------
If you planning on using Google Home integration you need to setup an account and obtain the associated JWT to send state reports to the Home Graph API::

    sudo mkdir -p /var/docker/red
    sudo vi /var/docker/red/.ghomejwt
    # Copy contents from downloaded JWT, supplied by Google
    sudo chmod 600 /var/docker/red/.ghomejwt

.. tip:: More information on this process `here. <https://developers.google.com/assistant/smarthome/develop/report-state#service-account-key>`_

Build/ Create NodeJS Docker Container
---------------
It is currently recommended to use source to build your container::

    cd ~
    rm -rf nodejs-webapp
    mkdir nodejs-webapp
    cd nodejs-webapp/
    git clone --single-branch -b development https://github.com/coldfire84/node-red-alexa-home-skill-v3-web.git .
    sudo docker build -t red:0.11 -f Dockerfile .

    sudo docker create --name red \
    --network nr-alexav3 \
    -p 3000:3000 \
    -v /etc/letsencrypt:/etc/letsencrypt \
    -v /var/docker/red/credentials:/root/.aws/credentials \
    -v /var/docker/red/.env:/usr/src/app/.env \
    -v /var/docker/red/.ghomejwt:/usr/src/app/ghomejwt.json \
    --restart always \
    --log-opt max-size=100m \
    --log-opt max-file=5 \
    red:0.11

    sudo docker start red
    sudo docker logs -f red

Create .env File
---------------
Copy the supplied template .env.template to a secure folder on your Docker host, i.e::

    sudo mkdir -p /var/docker/red
    sudo vi /var/docker/red/.env
    # Copy contents from template and populate accordingly
    sudo chmod 600 /var/docker/red/.env

Nginx
***************
Create the NGINX container using the following commands::

    sudo mkdir -p /var/docker/nginx/conf.d
    sudo mkdir -p /var/docker/nginx/stream_conf.d
    sudo mkdir -p /var/docker/nginx/includes
    sudo mkdir -p /var/docker/nginx/www

    export WEB_HOSTNAME=<external FQDN of web app>
    export MQTT_DNS_HOSTNAME=<external FDQN of MQTT service>

    # Get Config Files
    sudo wget -O /var/docker/nginx/conf.d/default.conf https://gist.github.com/coldfire84/47f90bb19a91f218717e0b7632040970/raw/65bb04af575ab637fa279faef03444f2525793db/default.conf

    sudo wget -O /var/docker/nginx/includes/header.conf https://gist.github.com/coldfire84/47f90bb19a91f218717e0b7632040970/raw/65bb04af575ab637fa279faef03444f2525793db/header.conf

    sudo wget -O /var/docker/nginx/includes/letsencrypt.conf https://gist.github.com/coldfire84/47f90bb19a91f218717e0b7632040970/raw/65bb04af575ab637fa279faef03444f2525793db/letsencrypt.conf

    sudo wget -O /var/docker/nginx/conf.d/nr-alexav3.cb-net.co.uk.conf https://gist.githubusercontent.com/coldfire84/47f90bb19a91f218717e0b7632040970/raw/b6ad451c0e60e94a78136efa37606901b2df11c4/nr-alexav3.cb-net.co.uk.conf

    sudo wget -O /var/docker/nginx/includes/restrictions.conf https://gist.github.com/coldfire84/47f90bb19a91f218717e0b7632040970/raw/65bb04af575ab637fa279faef03444f2525793db/restrictions.conf

    sudo wget -O /var/docker/nginx/includes/ssl-params.conf https://gist.github.com/coldfire84/47f90bb19a91f218717e0b7632040970/raw/65bb04af575ab637fa279faef03444f2525793db/ssl-params.conf

    sudo wget -O /var/docker/nginx/conf.d/mq-alexav3.cb-net.co.uk.conf https://gist.github.com/coldfire84/47f90bb19a91f218717e0b7632040970/raw/c234985e379a08c7836282b7efaff8669368dc41/mq-alexav3.cb-net.co.uk.conf

    sudo sed -i "s/<web-dns-name>/$WEB_HOSTNAME/g" /var/docker/nginx/conf.d/nr-alexav3.cb-net.co.uk.conf
    sudo sed -i "s/<web-dns-name>/$WEB_HOSTNAME/g" /var/docker/nginx/conf.d/mq-alexav3.cb-net.co.uk.conf
    sudo sed -i "s/<mq-dns-name>/$MQTT_DNS_HOSTNAME/g" /var/docker/nginx/conf.d/mq-alexav3.cb-net.co.uk.conf

    if [ ! -f /etc/letsencrypt/dhparams.pem ]; then
        sudo openssl dhparam -out /etc/letsencrypt/dhparams.pem 2048
    fi

    sudo docker create --network nr-alexav3 --name nginx -p 80:80 -p 443:443 \
    -v /var/docker/nginx/conf.d/:/etc/nginx/conf.d/ \
    -v /var/docker/nginx/stream_conf.d/:/etc/nginx/stream_conf.d/ \
    -v /etc/letsencrypt:/etc/nginx/ssl/ \
    -v /var/docker/nginx/includes:/etc/nginx/includes/ \
    -v /var/docker/nginx/www/:/var/www \
    --restart always \
    --log-opt max-size=100m \
    --log-opt max-file=5 \
    nginx

Dynamic DNS
***************
Depending on how/ where you deploy you may suffer from "ephemeral" IP addresses that changes on every power off/on of your cloud server(i.e. on Google Cloud Platform). You can pay for a Static IP address, or use ddclient to update CloudFlare or similar services::

    mkdir -p /var/docker/ddclient/config

    docker create \
    --name=ddclient \
    -v /var/docker/ddclient/config:/config \
    linuxserver/ddclient

    sudo vi /var/docker/ddclient/config/ddclient.conf

    ##
    ## Cloudflare (cloudflare.com)
    ##
    daemon=300
    verbose=yes
    debug=yes
    use=web, web=ipinfo.io/ip
    ssl=yes
    protocol=cloudflare
    login=<cloudflare username>
    password=<cloudflare global API key>
    zone=<DNS zone>
    <FQDN of web service>, <FQDN of MQTT service>

Create AWS Lambda Function
***************
Create a new AWS Lambda function in the following regions::

* eu-west-1 (for European users)
* us-east-1 (for US East-coast)
* us-west-1 (for APAC users)

.. tip:: If your users are localised to a specific region you can avoid deploying Lambda functions in all three locations, however if they are not you must deploy Lambda functions as outlined above.

Upload `node-red-alexa-home-skill-v3-lambda.zip <https://github.com/coldfire84/node-red-alexa-home-skill-v3-lambda/blob/development/node-red-alexa-home-skill-v3-lambda.zip>`_ from the `lambda repo. <https://github.com/coldfire84/node-red-alexa-home-skill-v3-lambda>`_

Set options as below::

* Runtime: Node.js 10.x
* Handler: index.handler
* From the top right of the Lambda console, copy the "ARN", i.e. arn:aws:lambda:eu-west-1:<number>:function:node-red-alexa-smart-home-v3-lambda - you will need this for the Alexa skill definition.

Finally, define an environment variable::

* WEB_API_HOSTNAME : set this to your web API hostname as defined in your .env file, i.e. "red.cb-net.co.uk"

Create Alexa Skill
***************
Under Build | Account Linking set:

* Authorization URI: `https://<hostname>/auth/start`
* Access Token URI: `https://<hostname>/auth/exchange`
* Client ID: is generated by system automatically on creating a new service via `https://<hostname>/admin/services` (client id starts at 1, is auto incremented)
* Gather redirect URLs from Alexa Skill config, enter with comma separation, i.e.
* Client Secret: manually generated numerical (yes, numerical only) i.e. 6600218816767991872626
* Client Authentication Scheme: Credentials in request body
* Scopes: access_devices and create_devices
* Domain List: <hostname used to publish web service>

Under Build | Permissions:

* Enable Send Alexa Events

.. tip:: Make note of the Alexa Client Id and Alexa Client Secret

Use the Client Id/ Client Secret in your .env file:

* ALEXA_CLIENTID=<skill send events client id>
* ALEXA_CLIENTSECRET=<skill send events client secret>

.. note:: Send Alexa Events enable the skill to send "out of band" state updates that are then reflected in the Alea App/ through voice queries.

Configure Web Service OAuth
***************
To configure OAuth / enable account linking between Amazon and the skill:

1. Browse to `https://<hostname>/login`
2. login to the Web Service using the credentials supplied in launching the Web App container via MQTT_USER and MQTT_PASSWORD
3. Browse to `https://<hostname>/admin/services`, create a new service using the same numerical secret above
4. Domain list is comma separated, for example: `layla.amazon.com,pitangui.amazon.com,alexa.amazon.co.jp`

.. tip:: Ensure the domain list is comma separated with **no** spaces.

Firewall Configuration
***************
External ports/ communication is all secured by either HTTPS or MQTT/TLS, as a result you will need to configure your external firewall as follows:

* Internet > TCP port 443 : HTTPS
* Internet > TCP port 8883 : MQTTS

Before executing these commands you need to confirm the subnet in use by the new Docker network you created. Use this command to confirm the subnet::

    sudo docker network inspect nr-alexav3 | grep Subnet

The following commands will configure UFW and Docker - **be sure to change '172.18.0.0/16' to match your subnet**::

    sudo apt-get install ufw

    # Set Default Rules
    sudo ufw default allow outgoing
    sudo ufw default deny incoming
    # Allow Management
    sudo ufw allow 22
    # Allow HTTP/HTTPS, we auto-rediect from HTTP>HTTPS
    sudo ufw allow 443
    sudo ufw allow 80
    sudo ufw allow 8883
    # Allow internal Docker network traffic for Redis, MQTT, MongoDB and NodeJS
    sudo ufw allow from 172.18.0.0/16 to any port 3000 proto tcp
    sudo ufw allow from 172.18.0.0/16 to any port 1883 proto tcp
    sudo ufw allow from 172.18.0.0/16 to any port 27017 proto tcp
    sudo ufw allow from 172.18.0.0/16 to any port 6397 proto tcp

    # Ensure Docker/ UFW inter-op (without this UFW rules are bypassed)
    sudo echo "{
    \"iptables\": false
    }" > /etc/docker/daemon.json
    sudo sed -i -e 's/DEFAULT_FORWARD_POLICY="DROP"/DEFAULT_FORWARD_POLICY="ACCEPT"/g' /etc/default/ufw
    sudo ufw reload
    # Use ifconfig/ sudo docker networks ls to find the network id, it will start "br-"
    sudo iptables -t nat -A POSTROUTING ! -o br-<network id> -s 172.18.0.0/16 -j MASQUERADE
    sudo apt-get install iptables-persistent netfilter-persistent
    # Save existing rules!
    sudo docker restart

Additionally you can configure fail2ban to provide brute-force protection on your server following the instructions here.

Configure AWS Cloudwatch Logging
***************
First, create the required Identity/ Group via the AWS IAM console::

1. Add a user: node-red-logger
2. Add a group: grp-node-red-log
3. Assign 'AmazonAPIGatewayPushToCloudWatchLogs' managed policy to the group.
4. Generate and Save API Key/ Secret

Now create a file that you can pass-through to docker container as /root/.aws/credentials - I use /var/docker/red/credentials in the command-line example for the container.

This file should contain::

    [default]
    aws_access_key_id = <YOUR_ACCESS_KEY_ID>
    aws_secret_access_key = <YOUR_SECRET_ACCESS_KEY>

MongoDB Backups
***************
Everything else is immutable, so our only real concern here is Mongodb backups.

1. Create a new S3 bucket, i.e: s3-node-red-alexa (capture access token and secret access token)
2. Create a new AWS Identity to use for access to the s3 bucket, i.e: id-backup-node-red-alexa, ensure you capture the access and secret access key.
3. Create a new Policy and attach to the new identity::

    {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Sid": "VisualEditor0",
                "Effect": "Allow",
                "Action": [
                    "s3:PutObject",
                    "s3:ListBucket",
                    "s3:PutObjectAcl"
                ],
                "Resource": "arn:aws:s3:::<s3-bucket-name>/*"
            }
        ]
    }

4. Install aws cli on the host using the command: sudo snap install aws-cli --classic
5. Configure aws cli using the command: aws configure entering the access and secret access key
6. Create a new script under: ~/scripts/s3-backup-mongodb.sh::

    #!/bin/bash

    # Variables
    ###########################
    CONTAINER="mongodb"
    DATETIME=$(date +"%Y_%m_%d")
    BACKUP_PATH="/var/docker/backup"
    LOCAL_BACKUP_THRESHOD="7"
    DROPBOX_BACKUP_THRESHOLD="28"
    # Container paths to backup

    # Script
    ###########################
    echo "Backing up conatiner: $CONTAINER"
    echo "Using backup path for tgz storage: $BACKUP_PATH"
    echo "Local backup threshold: $LOCAL_BACKUP_THRESHOD"
    echo "Remote backup threshold: $DROPBOX_BACKUP_THRESHOLD"

    # Perform Container Backup to tgz

    # Perform Backup
    CONTAINER_UPPER=$(echo $CONTAINER | awk '{print toupper($0)}')
    PATH_REPLACE=$(echo $i | sed -e 's/\//-/g')
    FILENAME="$DATETIME-$CONTAINER_UPPER$PATH_REPLACE.tgz"

    # Use mongodump to backup database
    mkdir -p /var/docker/backup/$CONTAINER_$DATETIME
    docker exec -e CONTAINER=$CONTAINER -e DATETIME=$DATETIME -it mongodb mongodump --host $CONTAINER:27017 --username <username> --authenticationDatabase admin --password <password> --out /backup/$CONTAINER_$DATETIME
    # Archive backup
    tar -cvzf /var/docker/backup/$FILENAME /var/docker/backup/$CONTAINER_$DATETIME
    # Remove backup files
    echo "Will remove folder: /var/docker/backup/$CONTAINER_$DATETIME/"
    rm -rf /var/docker/backup/$CONTAINER_$DATETIME/

    # Check for backup in expected backup path
    BACKUP_FILE="$BACKUP_PATH/$FILENAME"
    if [[ ! -f $BACKUP_FILE ]]; then
        echo "ERROR Backup file NOT found: $BACKUP_PATH/$FILENAME"
        exit 1;
    else
        echo "SUCCESS Backup file found: $BACKUP_PATH/$FILENAME"
    fi

    # Upload Backup to AWS S3
    aws s3 cp $BACKUP_PATH/$FILENAME s3://<s3-bucket-name>/$FILENAME

    # Cleanup LOCAL backup files older than Now - $LOCAL_BACKUP_THRESHOD days
    THRESHOLD=$(date +"%Y_%m_%d" -d "-$LOCAL_BACKUP_THRESHOD days");
    for i in $BACKUP_PATH/*$PATH_REPLACE.tgz
    do
        IFS='/' read -ra arrfilepath <<< "$i";
        IFS='-' read -ra arrfilename <<< "${arrfilepath[-1]}";
        if [[ ${arrfilename[0]} < $THRESHOLD ]]; then
            rm $i;
            echo "INFO Deleted aged backup: $i"
        fi
    done

Edit root crontab using the command sudo crontab -e, adding the following line (this will trigger a weekly backup at 22:45 every Saturday)::

    45 22 * * 6 /bin/bash <path to script>/s3-backup-mongodb.sh > <path to script>/backup-mongodb.log

.. tip:: Adjust the frequency of backups to suit your RPO.