// Schema =======================
var Account = require('../models/account');
var oauthModels = require('../models/oauth');
var Devices = require('../models/devices');
var Topics = require('../models/topics');
var LostPassword = require('../models/lostPassword');
// ===============================
// Winston Logger ============================
var logger = require('../config/logger');
var debug = (process.env.ALEXA_DEBUG || false);
// ===========================================

module.exports.updateUserServices = function updateUserServices(username, applicationName, callback) {
    Account.updateOne({username: username}, { $addToSet: {activeServices: applicationName}}, function (err, user){
        if (err) {
            logger.log('error', '[Auth] Unable to update user activeServices, error:' + err);
        }
        else {logger.log('verbose', '[Auth] Updated activeServices for user:' + username)}
    });
}