///////////////////////////////////////////////////////////////////////////
// Depends
///////////////////////////////////////////////////////////////////////////
var Account = require('../models/account');
var logger = require('../loaders/logger');

///////////////////////////////////////////////////////////////////////////
// Exports
///////////////////////////////////////////////////////////////////////////

const updateUserServices = async(username, applicationName) => {
    try {
        await Account.updateOne({username: username}, { $addToSet: {activeServices: applicationName}});
        logger.log('verbose', '[Services] Added service: ' + applicationName + ' to activeServices for user:' + username);
    }
    catch(e) {
        logger.log('error', '[Services] Unable to add service to activeServices, error:' + e.stack);
    }
}

const removeUserServices = async(username, applicationName) => {
    try {
        await Account.updateOne({username: username}, { $pull: {activeServices: applicationName} });
        logger.log('verbose', '[Services] Removed service: ' + applicationName + ' from activeServices for user:' + username);
    }
    catch(e) {
        logger.log('error', '[Services] Unable to remove service from activeServices, error:' + e.stack);
    }
}

module.exports = {
    updateUserServices,
    removeUserServices
}