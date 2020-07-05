.. toctree::
    :glob:
    :hidden:

    self
    getting-started.rst
    example-flows.rst
    node-outputs.rst
    state-reporting.rst
    troubleshooting.rst
    deploy-your-own.rst

**********
Introduction
**********
With 3000+ users, and 9500+ defined devices, available in 12 Amazon Alexa markets, English and German locales for Google Assistant (other markets/ locales to follow), Node-RED Smart Home Control enables you to quickly bring voice-control to your Node-RED flows, using Amazon Alexa and/ or Google Assistant.

You can support the ongoing development and hosting costs of this service via PayPal or alternatively through the `GitHub Sponsors programme <https://github.com/coldfire84>`_.

.. image:: _static/images/btn_donate_LG.gif
   :target: https://www.paypal.com/cgi-bin/webscr?cmd=_donations&business=A2F2KF4GKKXT6&currency_code=GBP&source=url

.. warning:: Node-RED Smart Home Control is an open source, free to use service. There is no warranty or support, implied or otherwise and the creators and contributors of this service and/ or related website are not responsible for any issues arising from it's use, including loss or damage relating to equipment, property, injury or life. You consume this service at your own risk.

Key Features
################
* Amazon Alexa and Google Assistant support, either enabled individually or in parallel.
* Support for a large array of device types including blinds, smart plugs, lights, thermostats (see more here).
* Supports "out of band" state updates (from physical or other automated device interactions) whilst providing real-time visibility of device state across Smart Assistant applications.

Regional Restrictions
################
.. tip:: There are Alexa restrictions based on region/ locale, Amazon publish and update their region-specific restrictions `here. <https://developer.amazon.com/it/docs/device-apis/list-of-interfaces.html>`_


Supported Capabilities
################

   +-------------+---------------+
   | Alexa       | Google        |
   | Interface   | Trait         |
   +=============+===============+
   | Brightness  | Brightness    |
   | Controller  |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   +-------------+---------------+
   | Channel     | Experimental  |
   | Controller  | (number only) |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   +-------------+---------------+
   | Color       | ColorSetting  |
   | Controller  |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   +-------------+---------------+
   | Color       | ColorSetting  |
   | Temperature |               |
   | Controller  |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   +-------------+---------------+
   | Contact     | None          |
   | Sensor      |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   +-------------+---------------+
   | Input       | None          |
   | Controller  |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   +-------------+---------------+
   | Lock        | Experimental\*|
   | Controller  |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   +-------------+---------------+
   | Motion      | None          |
   | Sensor      |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   +-------------+---------------+
   | Playback    | Experimental  |
   | Controller  |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   +-------------+---------------+
   | Percentage  | None          |
   | Controller  |               |
   |             |               |
   |             |               |
   |             |               |
   +-------------+---------------+
   | Power       | OnOff         |
   | Controller  |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   +-------------+---------------+
   | Range       | OpenClose     |
   | Controller  | (Support      |
   |             | for Blinds/   |
   |             | Awning        |
   |             | only)         |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   +-------------+---------------+
   | Scene       | Scene         |
   | Controller  |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   +-------------+---------------+
   | Speaker     | Experimental  |
   | Controller  |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   +-------------+---------------+
   | Step        | None          |
   | Speaker     |               |
   | Controller  |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   +-------------+---------------+
   | Temperature | None          |
   | Sensor      |               |
   |             |               |
   |             |               |
   |             |               |
   +-------------+---------------+
   | Thermostat  | Temperature   |
   | Control     | Setting       |
   | (Single     |               |
   | Point)      |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   |             |               |
   +-------------+---------------+