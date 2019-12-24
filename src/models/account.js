var mongoose = require('mongoose');
var Schema = mongoose.Schema;
var passportLocalMongoose = require('passport-local-mongoose');

var Account = new Schema({
    username: String,
    password: String,
    email: String,
    country:String,
    region: String,
    mqttPass: { type: String, default: '' },
    superuser: { type: Number, default: 0},
    topics: { type: Number},
    created: { type: Date, default: function(){
        return new Date();
    }},
    activeServices: [],
    active: { type: Boolean, default: true},
    isVerified: { type: Boolean, default: false}
});

var options = {
	usernameUnique: true,
	saltlen: 12,
	keylen: 24,
	iterations: 901,
    encoding: 'base64',
    limitAttempts: true,
    findByUsername: function(model, queryParameters) {
        // Add additional query parameter - AND condition - active: true
        queryParameters.active = true;
        return model.findOne(queryParameters);
      }
};

Account.plugin(passportLocalMongoose,options);

module.exports = mongoose.model('Account', Account);
