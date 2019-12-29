var fs = require("fs");
var ejs = require('ejs');
var path = require('path');
var nodemailer = require('nodemailer');
var logger = require('../loaders/logger');

var smtpOptions = {
	host: process.env.MAIL_SERVER,
	port: 465,
	secure: true,
	auth: {
		user: process.env.MAIL_USER,
		pass: process.env.MAIL_PASSWORD
	}
}

var lostPasswordTxtTemplate;
var lostPasswordHTMLTemplate;
var verifyEmailTxtTemplate;
var verifyEmailHTMLTemplate;

fs.readFile(
	path.join(__dirname, '../interfaces/views/email', 'resetPasswordText.ejs'),
	"utf-8",
	function(err, file){
		lostPasswordTxtTemplate = file;
	});

fs.readFile(
	path.join(__dirname, '../interfaces/views/email', 'resetPasswordHTML.ejs'),
	"utf-8",
	function(err, file){
		lostPasswordHTMLTemplate = file;
	});

fs.readFile(
	path.join(__dirname, '../interfaces/views/email', 'verifyEmailText.ejs'),
	"utf-8",
	function(err, file){
		verifyEmailTxtTemplate = file;
});

fs.readFile(
	path.join(__dirname, '../interfaces/views/email', 'verifyEmailHTML.ejs'),
	"utf-8",
	function(err, file){
		verifyEmailHTMLTemplate = file;
});

var transporter = nodemailer.createTransport(smtpOptions);

var Mailer = function() {

};

Mailer.prototype.send = function send(to, from, subject, text, html, callback){
	var message = {
		to: to,
		from: {
			name: process.env.BRAND,
			address: from
		},
		subject: subject,
		text: text,
		html: html
	};

	transporter.sendMail(message, function(error, info){
		if(error){
			logger.log('error' , "[Send Email] Error sending email, subject: " + message.subject +  ", to email address: " + message.to + ", error: " + error);
			callback(false);
		}
		else {
			logger.log('info' , "[Send Email] Sent email, subject: " + message.subject +  ", to email address: " + message.to + ", response: " + info.response);
			callback(true);
		}
	});
}

Mailer.prototype.buildLostPasswordBody = function buildLostBody(uuid, userid, fqdn){
	var body = ejs.render(lostPasswordTxtTemplate, {uuid: uuid, username: userid, fqdn: fqdn, brand: process.env.BRAND});
	var htmlBody = ejs.render(lostPasswordHTMLTemplate, {uuid: uuid, username: userid, fqdn: fqdn, brand: process.env.BRAND});
	return {text: body, html: htmlBody };
}


Mailer.prototype.buildVerifyEmail = function buildVerifyEmail(token, userid, fqdn){
	var body = ejs.render(verifyEmailTxtTemplate, {token: token, username: userid, fqdn: fqdn, brand: process.env.BRAND});
	var htmlBody = ejs.render(verifyEmailHTMLTemplate, {token: token, username: userid, fqdn: fqdn, brand: process.env.BRAND});
	return {text: body, html: htmlBody };
}

module.exports = Mailer;