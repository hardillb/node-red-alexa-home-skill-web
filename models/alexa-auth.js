var mongoose = require('mongoose');
var Schema = mongoose.Schema;

var GrantCodeSchema = new Schema({
	code: { type: String, unique: true},
	user: { type: Schema.Types.ObjectId, ref: 'Account' },
	active: { type: Boolean, default: true }
});

var AccessTokenSchema = new Schema({
	token: { type: String, unique: true },
	user: { type: Schema.Types.ObjectId, ref: 'Account' },
	grant: { type: Schema.Types.ObjectId, ref: 'AlexaAuthGrantCode' },
	expires: { type: Date, default: function(){
		var today = new Date();
		var length = 60; // Length (in minutes) of our access token
		return new Date(today.getTime() + length*60000);
	} },
	active: { type: Boolean, get: function(value) {
		if (this.expires < new Date() || !value) {
			return false;
		} else {
			return value;
		}
	}, default: true }
});

var RefreshTokenSchema = new Schema({
	token: { type: String, unique: true},
	user: { type: Schema.Types.ObjectId, ref: 'Account' }
});

var AlexaAuthGrantCode = mongoose.model('AlexaAuthGrantCode', GrantCodeSchema);
var AlexaAuthAccessToken = mongoose.model('AlexaAuthAccessToken', AccessTokenSchema);
var AlexaAuthRefreshToken = mongoose.model('AlexaAuthRefreshToken', RefreshTokenSchema);

module.exports = {
	AlexaAuthGrantCode: AlexaAuthGrantCode,
	AlexaAuthAccessToken: AlexaAuthAccessToken,
	AlexaAuthRefreshToken: AlexaAuthRefreshToken
}