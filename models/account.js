var mongoose = require('mongoose');
var Schema = mongoose.Schema;
var passportLocalMongoose = require('passport-local-mongoose');

var Account = new Schema({
    username: String,
    password: String,
    email: String,
    mqttPass: { type: String, default: '' },
    superuser: { type: Number, default: 0},
    topics: { type: Number}
});

Account.plugin(passportLocalMongoose);

module.exports = mongoose.model('Account', Account);
