var mongoose = require('mongoose');
var Schema = mongoose.Schema;

var Acls = new Schema({
    topic: String,
    acc: Number,
});

module.exports = mongoose.model('Acls', Acls);