var mongoose = require('mongoose');
var Schema = mongoose.Schema;

const verifyEmail = new Schema({
    user: { type: Schema.Types.ObjectId,  required: true, ref: 'Account' },
    token: { type: String, required: true },
    createdAt: { type: Date, required: true, default: Date.now, expires: 43200 }
});

module.exports = mongoose.model('VerifyEmail', verifyEmail);