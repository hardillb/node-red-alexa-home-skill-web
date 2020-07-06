.. _troubleshooting:

**********
Troubleshooting
**********
When something isn't working as expected you have a few things you can check.

Add a Node-RED Debug Node
################
Add a debug node after any "alexa-smart-home-v3" node, you can then verify that the command output is being received when you issue a voice command, or interact with a device using the Alexa/ Google Home applications. Ensure you configure the debug node to "output complete msg object."

.. image:: _static/images/debug.png
    :alt: Screenshot of debug node, linked to Node-RED Smart Home Control flow

You should see output as described :ref:`here <node-outputs>`.


Review the Node-RED Debug Console
################
Your next port of call is the built-in Node-RED debug console, available in the web-interface.

Node-RED Smart Home Control will send messages to your individual Node-RED instance if you send an incorrect state update/ an update that is in the wrong format. You will also be warned if your account is subject to `Throttling?`_

.. image:: _static/images/warning.png
    :alt: Screenshot of warning message in Node-RED debug console


Check Local MQTT Service
################
.. tip:: This is environment-specific. Most users will have a local MQTT service they have setup to act as a hub for their assisted/ smart homes.

If your environment contains a local MQTT server, such as Mosquitto, please ensure this is up and running - if down then device control will likely fail.


Check MQTT Messages
################
If you're not seeing any errors in the Node-RED debug console you can use "mosquitto_sub" to check for account-specific MQTT messages. This will enable you to confirm that the Node-RED Smart Home Control API is receiving your commands, at that they are available to your Node-RED Instance::

    mosquitto_sub -h mq-red.cb-net.co.uk -t '#' -v -u <bridge_username> -P '<bridge password>' --capath /etc/ssl/certs --id test-<bridge_username> -p 8883

If, after issuing a command via the Alexa or Google Home applications or, after using a voice command you see no output you should:

* Reset your password via the `My Account <https://red.cb-net.co.uk/my-account>`_ page - it may be your Web API and MQTT account passwords are no longer synchronised.

.. note:: You'll only see messages for your account, the service uses Access Control Lists (ACLs) to filter MQTT messages.

Check your Credentials
################
Getting 401 errors in Node-RED/ unable to authenticate to the MQTT server? It's worth checking your credentials.

Browse to the `<https://red.cb-net.co.uk/api/v1/devices>`_ Devices API and authenticate using your username and password, you should get a page full of text containing information about your defined devices.

If you're unable to browse this API/ you get a 401 error `reset your password <https://red.cb-net.co.uk/lost-password>`_ .


Review Node-RED Console Log
################
A more "involved" approach is to look at the Node-RED console logs. The service related Nodes/ contrib output significant information to the console log. Include any output here, and from the commands/ views above if you end up raising an issue on GuitHub.

For Docker-deployed instances, this is as simple as executing the command (container name dependant)::

    sudo docker logs -f <container_name>


Re-link Your Account
################
If you are still struggling to get the service working it is definitely worth un-linking/ disabling the service. Issues this may fix include:

* Discovery of new devices not working (Some long-term users of the service have been linked with a **development-only** edition of the service which can expire after 90 days of development inactivity.)
* Commands to existing devices not working

This is a three step process:

1. Use the Alexa/ Google Home smart assistant application to disable the service.
2. Browse to `My Account <https://red.cb-net.co.uk/my-account>`_ and hit Delete Tokens.
3. Re-link your Account via the Alexa/ Google Home smart assistant application.

.. tip:: Don't skip the "Delete Tokens" step, you're likely to continue having issues unless you complete this step.


Still Stuck?
################
Check out the `GitHub repository <https://github.com/coldfire84/node-red-alexa-home-skill-v3-web>`_ for this project where you can raise questions, bugs and feature requests.

There is also a new `Slack Workspace <https://join.slack.com/t/cb-net/shared_invite/enQtODc1ODgzNzkxNTM3LTYwZGZmNjAxZWZmYTU4ZDllOGM3OTMxMzI4NzRlZmUzZmQ4NDljZWZiOTIwNTYzYjJmZjVlYzhhYWFiNThlMDA>`_  where you discuss issues with other users.

.. warning:: Node-RED Smart Home Control is an open source, free to use service. There is no warranty or support, implied or otherwise and the creators and contributors of this service and/ or related website are not responsible for any issues arising from it's use, including loss or damage relating to equipment, property, injury or life. You consume this service at your own risk.


Throttling?
################
Yes, throttling. There is an AWS Lambda function that supports this service/ any Amazon Alexa interactions. In order to limit potential costs and ensure a good service experience for users across Node-RED Smart Home Control, a rate limiter is in-place for:

* Viewing state in the Alexa Application

In day-to-day usage you are extremely unlikely to be throttled, however during testing you may trigger the rate limit against your account/ a specific device.

.. note:: The current rate limit is 100 requests, per device, per hour. If you exceed the defined limit you will be unable to request state data on the specific device for one hour. Commands are currently unaffected by this limit. This is subject to change at any time, without warning.