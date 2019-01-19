var oauth2orize = require('oauth2orize');
var OAuth = require('./models/oauth');
var logger = require('./config/logger'); // Moved to own module

var server = oauth2orize.createServer();

server.grant(oauth2orize.grant.code({
	scopeSeparator: [ ' ', ',' ]
}, function(application, redirectURI, user, ares, done) {
	//logger.log("grant user: ", user);
	OAuth.GrantCode.findOne({application: application, user: user},function(error,grant){
		if (!error && grant) {
			done(null,grant.code); // Existing grant in-place
		} else if (!error) {
			var grant = new OAuth.GrantCode({
				application: application,
				user: user,
				scope: ares.scope
			});
			grant.save(function(error) {
				done(error, error ? null : grant.code);
			});
		} else {
			done(error,null); // Grant rrror
		}
	});

}));

server.exchange(oauth2orize.exchange.code({
	userProperty: 'appl'
}, function(application, code, redirectURI, done) {
	OAuth.GrantCode.findOne({ code: code }, function(error, grant) {
		if (grant && grant.active && grant.application == application.id) {
			var now = (new Date().getTime())
			OAuth.AccessToken.findOne({application:application, user: grant.user, expires: {$gt: now}}, function(error,token){
				if (token) {
					logger.log("debug", "Found valid AccessToken for user:" + grant.user);
					OAuth.RefreshToken.findOne({application:application, user: grant.user},function(error, refreshToken){
						if (refreshToken){
							logger.log("debug", "Found valid RefreshToken for user:" + grant.user);
							var expires = Math.round((token.expires - (new Date().getTime()))/1000);
							done(null,token.token, refreshToken.token,{token_type: 'Bearer', expires_in: expires});
							logger.log("debug", "AccessToken sent expires_in: " + expires);
						} else {
							// Shouldn't get here unless there is an error as there
							// should be a refresh token if there is an access token
							logger.log("debug", "Error, could not find valid RefreshToken for user:" + grant.user);
							done(error);
						}
					});
				} else if (!error) {
					logger.log("debug", "Valid AccessToken not found for user:" + grant.user);
					var token = new OAuth.AccessToken({
						application: grant.application,
						user: grant.user,
						grant: grant,
						scope: grant.scope
					});
					token.save(function(error){
						var expires = Math.round((token.expires - (new Date().getTime()))/1000);
						//delete old refreshToken or reuse?
						OAuth.RefreshToken.findOne({application:application, user: grant.user},function(error, refreshToken){
							if (refreshToken) {
								done(error, error ? null : token.token, refreshToken.token, error ? null : { token_type: 'Bearer', expires_in: expires, scope: token.scope});
							} else if (!error) {
								var refreshToken = new OAuth.RefreshToken({
									user: grant.user,
									application: grant.application
								});
								logger.log("debug", "Created RefreshToken for user:" + grant.user + ", expires_in:" + expires);
								logger.log(JSON.stringify(refreshToken));

								refreshToken.save(function(error){
									done(error, error ? null : token.token, refreshToken.token, error ? null : { token_type: 'Bearer', expires_in: expires, scope: token.scope});
								});
							} else {
								done(error);
							}
						});
					});
				} else {
					done(error);
				}
			});

		} else {
			done(error, false);
		}
	});
}));

server.exchange(oauth2orize.exchange.refreshToken({
	userProperty: 'appl'
}, function(application, token, scope, done){
	OAuth.RefreshToken.findOne({token: token}, function(error, refresh){
		if (refresh && refresh.application == application.id) {
			// Add filter for application: application.id, as we have multiple grants per user
			OAuth.GrantCode.findOne({application: application.id},function(error, grant){
				if (grant && grant.active && grant.application == application.id){
					var newToken = new OAuth.AccessToken({
						application: refresh.application,
						user: refresh.user,
						grant: grant,
						scope: grant.scope
					});

					newToken.save(function(error){
						var expires = Math.round((newToken.expires - (new Date().getTime()))/1000);
						if (!error) {
							logger.log("debug", "Created AccessToken for user:" + refresh.user  + ", expires_in:" + expires);
							logger.log(JSON.stringify(newToken));
							logger.log("debug", "Access Token saved")
							done(null, newToken.token, refresh.token, {token_type: 'Bearer', expires_in: expires, scope: newToken.scope});
						} else {
							logger.log("debug", "Error saving token")
							done(error,false);
						}
					});
				} else {
					if (!grant) {logger.log("debug", "Error, GrantCode not found")};
					if (!grant.active) {logger.log("debug", "Error, grant not active")};
					if (grant.application != application.id){logger.log("debug", "Error, grant.application: " + grant.application + " does not match application.id:" + application.id)};
					done(error,null);
				}
			});
		} else {
			if (!refresh) {logger.log("debug", "Error, refresh token not found for application:" + application.title)};
			if (refresh.application != application.id){logger.log("debug", "Error, refresh.application: " + refresh.application + " does not match application.id:" + application.id)};
			done(error, false);
		}
	});
}));

server.serializeClient(function(application, done) {
	done(null, application.id);
});

server.deserializeClient(function(id, done) {
	OAuth.Application.findById(id, function(error, application) {
		done(error, error ? null : application);
	});
});

module.exports = server;