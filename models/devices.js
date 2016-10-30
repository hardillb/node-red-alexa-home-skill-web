var mongoose = require('mongoose');
var Schema = mongoose.Schema;

var Devices = new Schema({
    username: String,
    applianceId: String,
    friendlyName: String,
    friendlyDescription: String,
    isReachable: Boolean,
    action: [String],
    additionalApplianceDetails: {
    	extraDetail1: String,
    	extraDetail2: String,
    	extraDetail3: String,
    	extraDetail4: String
    }
});

module.exports = mongoose.model('Devices', Devices);