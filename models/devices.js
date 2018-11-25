var mongoose = require('mongoose');
var Schema = mongoose.Schema;
var AutoIncrement = require('mongoose-sequence')(mongoose);

var Devices = new Schema({
    username: String,
    endpointId: Number,
    friendlyName: String,
    description: String,
    capabilities: [],
    displayCategories: [String],
    validRange: {
        minimumValue: Number,
        maximumValue: Number,
        scale: String
    },
    cookie: {
    	extraDetail1: String,
    	extraDetail2: String,
    	extraDetail3: String,
    	extraDetail4: String
    },
    reportState: Boolean,
    state: Schema.Types.Mixed
});

Devices.plugin(AutoIncrement, {inc_field: 'endpointId'});

module.exports = mongoose.model('Devices', Devices);