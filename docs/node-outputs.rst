.. _node-outputs:

**********
Default Node Outputs
**********
Note that outputs are consistent across Alexa and Google Home issued commands, this is intentional in order to eliminate the need to re-engineer flows/ create complex logic to manage the different command directives.

General Capabilities/ Traits
################

Percentage Control
***************
Adjust percentage command output, used when reducing/ increasing percentage (either by a specific amount or stating "increase"/ "decrease")::

    msg : {
        topic: ""
        name: "Test Fan"
        _messageId: "ffa95808-dc09-4c50-a242-d166acb05d1b"
        _endpointId: "104"
        _confId: "bfd0fcf4.bc90e"
        command: "AdjustPercentage"
        extraInfo: object
        payload: 25
        acknowledge: true
        _msgid: "68eadf30.4f1a4"
    }

.. tip:: msg.payload will be a +/- numerical value to be used in adjustment

Set percentage command output, used when specifying a percentage, such as 25%::

    msg : {
        topic: ""
        name: "Test Fan"
        _messageId: "6851dbbf-e826-41f9-89ee-7cd4c9699a17"
        _endpointId: "104"
        _confId: "bfd0fcf4.bc90e"
        command: "SetPercentage"
        extraInfo: object
        payload: 25
        acknowledge: true
        _msgid: "a9433270.f9ea8"
    }

.. tip:: msg.payload will be a numerical value for specific percentage

Power Control
***************
Set percentage command output, for "turn on" commands::

    msg : {
        topic: ""
        name: "Study Light"
        _messageId: "0791c4b3-c874-4192-a5ac-4c4b643c36ab"
        _endpointId: "17"
        _confId: "bfd0fcf4.bc90e"
        command: "TurnOn"
        extraInfo: object
        payload: "ON"
        acknowledge: true
        _msgid: "c94c43fa.41d31"
    }

.. tip:: msg.payload will be a string, either "ON" or "OFF"

Scene Control
***************
On scene activation::

    msg : {
        topic: ""
        name: "Movie Night"
        _messageId: "3b6f7aa1-38c3-45a4-a94d-96e488c6d5ad"
        _endpointId: "7"
        _confId: "bfd0fcf4.bc90e"
        command: "Activate"
        extraInfo: object
        payload: "ON"
        acknowledge: true
        _msgid: "c3f50a98.9e0b08"
    }

.. tip:: msg.payload will be string, and will always be "ON"

Light-Specific Capabilities/ Traits
################

Brightness Control
***************
Adjust Brightness command output, used when reducing/ increasing brightness (either by a specific amount or stating increase/ decrease)::

    msg : {
        topic: ""
        name: "Bedroom Light"
        _messageId: "8cbe1407-34f1-4eef-97c9-007b4b4edcfd"
        _endpointId: "29"
        _confId: "bfd0fcf4.bc90e"
        command: "AdjustBrightness"
        extraInfo: object
        payload: -25
        acknowledge: true
        _msgid: "87891d99.acdbb"
    }

.. tip:: msg.payload will be a +/- numerical value to be used in adjustment

Set brightness command output, used when specifying a percentage, such as 80%::

    msg : {
        topic: ""
        name: "Bedroom Light"
        _messageId: "9c289ee2-fd71-4222-ad55-8a894f70b319"
        _endpointId: "29"
        _confId: "bfd0fcf4.bc90e"
        command: "SetBrightness"
        extraInfo: object
        payload: 80
        acknowledge: true
        _msgid: "c484148c.0aa918"
    }

.. tip:: msg.payload will be a numerical value for specific percentage

Color Control
***************
Set colour command output, used when specifying a colour, such as green::

    msg : {
        topic: ""
        name: "Test Smartlight"
        _messageId: "245ae0ea-40cb-4a44-8618-fdea822de1bf"
        _endpointId: "99"
        _confId: "bfd0fcf4.bc90e"
        command: "SetColor"
        extraInfo: object
        payload: {
            "hue": 350.5,
            "saturation": 0.7138,
            "brightness": 0.6524
            }
        acknowledge: true
        _msgid: "334fa7b2.f8d148"
    }

.. tip:: msg.payload will be a JSON object containing hue, saturation and brightness values

Color Temperature Control
***************
Set color temperature command output, used when specifying values either by name, or numerical value in Kelvin:

    -  warm \|\| warmwhite: 2200
    -  incandescent \|\| soft white: 2700
    -  white: 4000
    -  daylight \|\| daylight white:5500
    -  cool \|\| cool white: 7000

::

    msg : {
        topic: ""
        name: "Bedroom Light"
        _messageId: "d506edb8-29a4-4009-9882-b17fe18e982d"
        _endpointId: "99"
        _confId: "bfd0fcf4.bc90e"
        command: "SetColorTemperature"
        extraInfo: object
        payload: 2200
        acknowledge: true
        _msgid: "47f1c84f.65f138"
    }

.. tip:: msg.payload will a numerical value, representing colour temperature in Kelvin

Lock-Specific Capabilities/ Traits
################
Lock/ unlock command output::

    msg : {
        topic: ""
        name: "Door Lock"
        _messageId: "5a15c0c4-1e05-4ca6-bf40-fca4393c2ec4"
        _endpointId: "128"
        _confId: "bfd0fcf4.bc90e"
        command: "Lock"
        extraInfo: object
        payload: "Lock"
        acknowledge: true
        _msgid: "7ce7f0e3.e96bd"
    }

.. tip:: msg.payload will be a string, either "Lock" or "Unlock"

Media-Specific Capabilities/ Traits
################

Channel Control
***************
Change channel command output, used when specifying a channel number, such as 101::

    msg : {
        topic: ""
        name: "Lounge TV"
        _messageId: "01843371-f3e1-429c-9a68-199b77ffe577"
        _endpointId: "11"
        _confId: "bfd0fcf4.bc90e"
        command: "ChangeChannel"
        extraInfo: object
        payload: "101"
        acknowledge: true
        _msgid: "bd3268f0.742d98"
    }

.. tip:: msg.payload will be a numerical value, representing the specific channel number

Command output, used when specifying a channel number, such as "BBC 1"::

    msg : {
        topic: ""
        name: "Lounge TV"
        _messageId: "c3f8fb2d-5882-491f-b0ce-7aa79eaad2fe"
        _endpointId: "11"
        _confId: "bfd0fcf4.bc90e"
        command: "ChangeChannel"
        extraInfo: object
        payload: "BBC 1"
        acknowledge: true
        _msgid: "db9cc171.e30de"
    }

.. tip:: msg.payload will be a string, representing the name of the channel requested

.. warning:: Channel names are only supported by Alexa, you can only use channel numbers when using this capability/ trait with Google Assistant.

Input Control
***************
Select input command output, used when specifying an input such as "HDMI 2"::

    msg : {
        topic: ""
        name: "Lounge TV"
        _messageId: "4e12b3dd-c5a0-457a-ad8b-db1799e10398"
        _endpointId: "11"
        _confId: "bfd0fcf4.bc90e"
        command: "SelectInput"
        extraInfo: object
        payload: "HDMI 2"
        acknowledge: true
        _msgid: "74f61e13.34871"
    }

.. tip:: msg.payload will be a string, representing the requested input. Supported input names: HDMI1, HDMI2, HDMI3, HDMI4, phono, audio1, audio2 and "chromecast"

Playback Control
***************
For playback control, msg.command changes, based upon the requested action (i.e. Play, Pause etc)::

    msg : {
        topic: ""
        name: "Lounge TV"
        _messageId: "f4379dcb-f431-4662-afdc-dc0452d313a0"
        _endpointId: "11"
        _confId: "bfd0fcf4.bc90e"
        command: "Play"
        extraInfo: object
        acknowledge: true
        _msgid: "fda4a47c.e79c08"
    }

.. tip:: msg.payload will be a string, supported commands: Play, Pause, Stop, Fast Forward, Rewind, Next, Previous, Start Over

Volume Control
***************
.. tip:: There are two speaker device types, a "Step Speaker" which is a "dumb" speaker that has no state and a "Speaker" which can return state (in terms of volume level).

Adjust volume command::

    msg : {
        topic: ""
        name: "Test Speaker"
        _messageId: "77c8161c-8935-446a-9087-2ee0b9b90cdc"
        _endpointId: "98"
        _confId: "bfd0fcf4.bc90e"
        command: "AdjustVolume"
        extraInfo: object
        payload: 10
        acknowledge: true
        _msgid: "9f95ad7e.c2574"
    }

.. tip:: msg.payload will be a +/- numerical value, if no value specified message msg.payload will be +/- 10

.. warning:: For "Step Speaker" devices, msg.payload will always be +/- 10.

Set volume command, used to set to specific value/ percentage::

    msg : {
        topic: ""
        name: "Lounge TV"
        _messageId: "0bfd0aac-8dd1-4c8c-a341-9cfb14fa06d6"
        _endpointId: "11"
        _confId: "bfd0fcf4.bc90e"
        command: "SetVolume"
        extraInfo: object
        payload: 50
        acknowledge: true
        _msgid: "aa31e847.2da6e8"
    }

.. tip:: msg.payload will be a +/- numerical value for specific percentage

.. warning:: "Step Speaker" volume cannot be set to a specific number.

Mute command::

    msg : {
        topic: ""
        name: "Lounge TV"
        _messageId: "7fd278b4-1e9f-4195-9dc9-40e378a5f24b"
        _endpointId: "11"
        _confId: "bfd0fcf4.bc90e"
        command: "SetMute"
        extraInfo: object
        payload: "ON"
        acknowledge: true
        _msgid: "8fcd1348.907e1"
    }

.. tip:: msg.payload will be a string, either "ON" or "OFF"

Thermostat-Specific Capabilities/ Traits
################

Adjust Temperature
***************
Adjust the temperature through "lower," "raise," "turn up the heat" etc. commands::

    msg : {
        topic: ""
        name: "Thermostat"
        _messageId: "3b618e03-f112-4e54-a291-62953467a1f3"
        _endpointId: "91"
        _confId: "bfd0fcf4.bc90e"
        command: "AdjustTargetTemperature"
        extraInfo: object
        payload: 1
        temperatureScale: "CELSIUS"
        acknowledge: true
        _msgid: "26950952.9183b6"
    }

.. tip:: msg.payload will be +/- 1, the number to adjust the thermostat set point by

Set Target Temperature
***************
Set target temperature::

    msg : {
        topic: ""
        name: "Thermostat"
        _messageId: "67ebfd1b-dd16-4681-afb3-e0d0f3152865"
        _endpointId: "91"
        _confId: "bfd0fcf4.bc90e"
        command: "SetTargetTemperature"
        extraInfo: object
        payload: 22
        temperatureScale: "CELSIUS"
        acknowledge: true
        _msgid: "b8afdc95.b06fe"
    }

.. tip:: msg.payload will be a numerical value, representing desired/ target temperature

Set Thermostat Mode
***************
Available modes will depend upon device configuration within the Node-RED Smart Home Control service, as well as the physical device capabilities::

    msg : {
        topic: ""
        name: "Thermostat"
        _messageId: "7f5b0559-f015-4e75-9443-3feac8fe6ac5"
        _endpointId: "91"
        _confId: "bfd0fcf4.bc90e"
        command: "SetThermostatMode"
        extraInfo: object
        payload: "OFF"
        acknowledge: true
        _msgid: "6a879991.5d6d38"
    }

.. tip:: msg.payload will be a string, API supported modes: Auto, Eco, Heat, Cool, On, Off (support varies by smart assistant platform)