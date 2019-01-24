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
            logger.log('error', '[Services] Unable to add service to activeServices, error:' + err);
        }
        else {logger.log('verbose', '[Services] Added service: ' + applicationName + ' to activeServices for user:' + username)}
    });
}

module.exports.removeUserServices = function removeUserServices(username, applicationName, callback) {
    Account.updateOne({username: username}, { $pull: {activeServices: applicationName} }, function (err, user){
        if (err) {
            logger.log('error', '[Services] Unable to remove service from activeServices, error:' + err);
        }
        else {logger.log('verbose', '[Services] Removed service: ' + applicationName + ' from activeServices for user:' + username)}
    });
}