const cfg = require("./config.json");
const log4js = require("log4js");

log4js.configure(cfg.log.config);

exports.logger = log4js.getLogger();

exports.exp = log4js.getLogger('express');

exports.exp.stream = {
	write: function(msg) {
		exports.exp.info(msg.trim());
	}
};
