**********
State Reporting
**********

.. _capabilities-state:

Capabilities that Support State
################
Not all capabilities/ traits support state updates, the table below illustrates those that do:

    ========================== ========= ===========
    Capability                 Alexa App Google Home
    ========================== ========= ===========
    BrightnessController       YES       YES
    ChannelController          NO        N/A
    ColorController            YES       YES\*
    ColorTemperatureController YES       YES\*
    ContactSensor              YES       N/A
    InputController            NO        N/A
    LockController             YES       N/A
    MotionSensor               YES       N/A
    PercentageController       YES       N/A
    PlaybackController         NO        N/A
    PowerController            YES       YES
    RangeController            YES       YES
    SceneController            NO        NO
    Speaker                    YES       N/A
    StepSpeaker                NO        N/A
    TemperatureSensor          YES       N/A
    ThermostatController       YES       YES
    ========================== ========= ===========

.. note:: Google Home support for capabilities varies by mobile platform (i.e. iOS vs Android).

Expected State Payload
################
State payload format is *very specific* - as a minimum you must include msg.acknowledge set to ``true`` and a state element update that is relevant for the device. For example, a device that has a PowerController capability can have it's state set if the following is passed to the "alexa-smart-home-v3-state" node::

    msg : {
        "acknowledge":true,
        "payload" : {
            "state" : {
                "power": "ON"
            }
        }
    }

.. warning:: If you disable "Auto Acknowledge" you must set msg.acknowledge to true later in the flow, otherwise any command and state update will be dropped.

State Payload Reference
################
Where "||" is listed this implies "OR" - do not include this in your state responses, they will be dropped::

    msg {
        acknowledge: true,
        payload {
            state {
                "brightness": 0-100,
                "colorbrightness": 0-1,
                "colorHue": 0-360,
                "colorSaturation": 0-1,
                "colorTemperature": 0-10000,
                "contact": "DETECTED" || "NOT_DETECTED"
                "input": string,
                "lock": "LOCKED" || "UNLOCKED",
                "motion": "DETECTED" || "NOT_DETECTED"
                "percentage": number,
                "percentageDelta": number,
                "playback": "Play",
                "power": "ON" || "OFF",
                "range":  number (1-100 for blinds/ awnings, 1-10 for other devices),
                "temperature": number,
                "thermostatMode": "HEAT" || "COOL",
                "thermostatSetPoint" : number,
                "targetSetpointDelta": number,
                "volume": number,
                "volumeDelta": number
            }
        }
    }