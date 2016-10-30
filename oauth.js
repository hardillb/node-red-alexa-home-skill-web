var oauth2orize = require('oauth2orize'); 
var OAuth = require('./models/oauth');

var server = oauth2orize.createServer();

server.grant(oauth2orize.grant.code({
	scopeSeparator: [ ' ', ',' ]
}, function(application, redirectURI, user, ares, done) {
	var grant = new OAuth.GrantCode({
		application: application,
		user: user,
		scope: ares.scope
	});
	grant.save(function(error) {
		done(error, error ? null : grant.code);
	});
}));

server.exchange(oauth2orize.exchange.code({
	userProperty: 'appl'
}, function(application, code, redirectURI, done) {
	OAuth.GrantCode.findOne({ code: code }, function(error, grant) {
		if (grant && grant.active && grant.application == application.id) {
			var token = new OAuth.AccessToken({
				application: grant.application,
				user: grant.user,
				grant: grant,
				scope: grant.scope
			});
			token.save(function(error) {
				done(error, error ? null : token.token, null, error ? null : { token_type: 'standard' });
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