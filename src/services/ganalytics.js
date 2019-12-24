///////////////////////////////////////////////////////////////////////////
// Depends
///////////////////////////////////////////////////////////////////////////
var ua = require('universal-analytics');
///////////////////////////////////////////////////////////////////////////
// Variables
///////////////////////////////////////////////////////////////////////////
// Google Analytics ==========================
var enableAnalytics = false;
if (process.env.GOOGLE_ANALYTICS_TID != undefined) {
    enableAnalytics = true;
    var visitor = ua(process.env.GOOGLE_ANALYTICS_TID);
}

// Send Anonymous
module.exports.sendPageView = function sendPageView(requestPath, friendlyName, userIp, userAgent){
    var view = {
		dp: requestPath,
		dh: 'https://' + process.env.WEB_HOSTNAME,
		dt: friendlyName,
		uip: userIp,
		ua: userAgent
    }
	if (enableAnalytics) {visitor.pageview(view).send()};
}

// Send with userId
module.exports.sendPageViewUid = function sendPageViewUid(requestPath, friendlyName, userIp, userId, userAgent){
    var view = {
		dp: requestPath,
		dh: 'https://' + process.env.WEB_HOSTNAME,
		dt: friendlyName,
        uip: userIp,
        uid: userId,
		ua: userAgent
    }
	if (enableAnalytics) {visitor.pageview(view).send()};
}

// Send with userId
module.exports.sendEventUid = function sendEventUid(requestPath, eventClass, message, userIp, userId, userAgent){
    var params = {
        ec: eventClass,
        ea: message,
        uid: userId,
        uip: userIp,
        dp: requestPath,
        ua: userAgent
        }
    if (enableAnalytics) {visitor.event(params).send()};


}