var oauth2orize = require('oauth2orize');
var OAuth = require('./models/oauth');

var server = oauth2orize.createServer();

server.grant(oauth2orize.grant.code({
	scopeSeparator: [ ' ', ',' ]
}, function(application, redirectURI, user, ares, done) {
	//console.log("grant user: ", user);
	OAuth.GrantCode.findOne({application: application, user: user},function(error,grant){
		if (!error && grant) {
			//console.log("Grant, existing grant code found");
			//console.log("%j", grant);
			done(null,grant.code);
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
			done(error,null);
		}
	});

	// var grant = new OAuth.GrantCode({
	// 	application: application,
	// 	user: user,
	// 	scope: ares.scope
	// });
	// grant.save(function(error) {
	// 	done(error, error ? null : grant.code);
	// });
}));

server.exchange(oauth2orize.exchange.code({
	userProperty: 'appl'
}, function(application, code, redirectURI, done) {
	OAuth.GrantCode.findOne({ code: code }, function(error, grant) {
		if (grant && grant.active && grant.application == application.id) {
			//console.log("exchange, found grant code")
			var now = new Date().getTime()
			OAuth.AccessToken.findOne({application:application, user: grant.user, expires: { $gt: now}}, function(error,token){
				if (token) {
					//console.log("Active access token found");
					//console.log("%j", token);
					OAuth.RefreshToken.findOne({application:application, user: grant.user},function(error, refreshToken){
						if (refreshToken){
							var expires = Math.round((token.expires - (new Date().getTime()))/1000);
							done(null,token.token, refreshToken.token,{token_type: 'Bearer', expires_in: expires});
							//console.log("refresh token found, sent expires_in: " + expires);
						} else {
							// Shouldn't get here unless there is an error as there
							// should be a refresh token if there is an access token
							console.log("no refresh token found for existing access token");
							console.log("%j",error);
							done(error);
						}
					});
				} else if (!error) {
					console.log("exchange, no access token found");
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
								console.log("Should never get here, new accessToken with old refresh token");
								done(error, error ? null : token.token, refreshToken.token, error ? null : { token_type: 'Bearer', expires_in: expires, scope: token.scope});
							} else if (!error) {
								//console.log("creating new refresh token")
								var refreshToken = new OAuth.RefreshToken({
									user: grant.user,
									application: grant.application
								});

								refreshToken.save(function(error){
									//console.log("sending new token access and refresh token");
									done(error, error ? null : token.token, refreshToken.token, error ? null : { token_type: 'Bearer', expires_in: expires, scope: token.scope });
								});
							} else {
								console.log("err1");
								done(error);
							}
						});
					});
				} else {
					console.log("err2");
					done(error);
				}
			});

		} else {
			console.log("err3");
			done(error, false);
		}
	});
}));

server.exchange(oauth2orize.exchange.refreshToken({
	userProperty: 'appl'
}, function(application, token, scope, done){
	//console.log("Yay!");
	OAuth.RefreshToken.findOne({token: token}, function(error, refresh){
		if (refresh && refresh.application == application.id) {
			OAuth.GrantCode.findOne({user: refresh.user},function(error, grant){
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
							done(null, newToken.token, refresh.token, {token_type: 'Bearer', expires_in: expires, scope: newToken.scope});
						} else {
							done(error,false);
						}
					});
				} else {
					done(error,null);
				}
			});
		} else {
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