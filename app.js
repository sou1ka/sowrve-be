// config
const cfg = require("./config.json");
const path = require('path');
const express = require("express");
const morgan = require("morgan");
const fs = require('fs');
const sqlite = require('better-sqlite3');
const id3 = require("jsmediatags");
const compression = require("compression");
const { logger, exp } = require("./logger");
const { spawn } = require('child_process')
const mpv = require('node-mpv');

let app = express();
let bodyParser = require('body-parser');

const db = new sqlite('sowrver.sqlite');
let player = new mpv({
	"verbose": true,
	"audio_only": true
});

let playstatus = '';

// conpress
app.use(compression({
	threshold: 0,
	level: 9,
	memLevel: 9
}));

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// logger init
morgan.token('token', function getId(req) {
	return 'X-Real-IP: ' + (req.headers['x-real-ip'] || req.ip) + ' User: ' + (req.user ? req.user.username : req.user) + ' Params: ' + JSON.stringify(req.params) + ' Body:' + JSON.stringify(req.body);
});

app.use(morgan(':remote-addr - :method :url - HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent" [:response-time ms :token]', { stream: exp.stream }));

let server = app.listen(cfg.Port, function() {
	logger.info("Node.js is listening to PORT:" + server.address().port);
	logger.info("queue table is truncate.");
	db.prepare('delete from queue').run();
});

app.use(express.static(path.join(__dirname, 'www')));

// favicon
let favicon = require('serve-favicon');
app.use(favicon(__dirname + '/www/favicon.ico'));

// method
const rfiles = function(dir) {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap(dirent =>
    	dirent.isFile() ? [`${dir}/${dirent.name}`] : rfiles(`${dir}/${dirent.name}`)
	);
}

const files = function(dir) {
	return fs.readdirSync(dir, { withFileTypes: true }).filter(dirent => dirent.isFile()).map(({ name}) => name);
}

const id3read = async function(path) {
	return new Promise((resolve, reject) => {
		new id3.Reader(path)
			.read({
			onSuccess: (tag) => {
				resolve(tag);
			},
			onError: (error) => {
				logger.error('ID3 read error: ', error.type, error.info);
				reject(error);
			}
		});
	});
}

const db_insert = function(table, data) {
	let col = Object.keys(data).join(',');
	let pre = new Array(Object.keys(data).length).fill('?');
	let sql = 'insert into ' + table + '(' + col + ')values(' + pre + ')';
	let val = Object.values(data);
//	console.log(sql);
//	console.log(val);
	try {
		db.prepare(sql).run(val);
	} catch(e) {
		console.error(e);
		console.log(sql);
		console.log(val);
	}
}

// router
app.use("/lib.json", function(req, res) {
	let stmt = db.prepare("select * from lib");
	let rows = stmt.all();
	res.json(rows);
});

app.use("/insertlib.json", function(req, res) {
	let param = (Object.keys(req.query).length !== 0 ? req.query : req.body);

	if(param) {
		let path = param.path;
		let recursive = param.recursive;

		let stmt = db.prepare("select count(*) from lib");
		let count = stmt.all();
		let id = count + 1;

		db_insert('lib', {
			id: id,
			path: path,
			recursive: recursive
		});

		stmt = db.prepare("select * from lib where id = ?");
		let rows = stmt.all(id);

		res.json(rows);

	} else {
		res.json({});
	}
});

app.use("/tag.json", async function(req, res) {
	let param = (Object.keys(req.query).length !== 0 ? req.query : req.body);

	if(param) {
		let fullpath = path.join(param.path, param.name);
		let tag = await id3read(fullpath);
		res.json(tag);

	} else {
		res.json({});
	}
});

app.use("/readlib.json", async function(req, res) {
	let stmt = db.prepare("select * from lib");
	let rows = stmt.all();
	let count = 0;
	let readFile = 0;

	if(rows) {
		db.prepare('delete from file').run();
		db.prepare('delete from playlist').run();

		for(let nm of rows) {
			let list = rfiles(nm.path);
			readFile += list.length;

			for(let d of list) {
				logger.info('Read file: ' + d);
				let fullpath = path.dirname(d);
				let parent = fullpath.split(path.sep).pop();
				let ext = path.extname(d);
				if(ext == '.m3u') {
					db_insert('playlist', {
						path: nm.path,
						name: d,
					});

				} else {
					let tag = {};
					try {
						let t = await id3read(d);
						
						if(t && t.tags) {
							tag = t.tags;
						}
					} catch(e) {
						logger.error('ID3tag error: ' + e);
						continue;
					}

					//console.log(path.join(nm.path, list[0]));console.log(tag);console.log(list[0]);console.log(parent);console.log(nm);
					let bin = new Uint8Array(0);
					if(tag.picture) {
						bin = new Uint8Array(tag.picture.data);
					}

					db_insert('file', {
						path: fullpath,
						dir: parent,
						name: path.basename(d),
						like: 0,
						tag_title: tag.title,
						tag_album: tag.album,
						tag_artist: tag.artist,
						tag_genre: tag.genre,
						tag_track: tag.track,
						tag_year: tag.year,
						tag_comment: String(tag.comment || '') || null,
						tag_cover: bin
					});

					count++;
				}
			}
		}

	}

	res.json({
		readFile: readFile,
		count: count,
		targets: rows
	});

});

app.use("/musics.json", function(req, res) {
	let col = ['path', 'dir', 'name', 'like', 'tag_title', 'tag_album', 'tag_artist', 'tag_genre', 'tag_track', 'tag_year', 'tag_comment'];
	let group = '';
	let where = [];
	let params = [];
	let param = (Object.keys(req.query).length !== 0 ? req.query : req.body);

	if(param && param.search) {
		let ps = param.search.split(/[\s|　]/g);
		for(let p of ps) {
			for(let c of col) {
				where.push(c + ' like lower(?)');
				params.push('%'+ String(p).toLowerCase() + '%');
			}
		}
	} else {
		where.push('1 = 1');
	}

	if(param && param.group) {
		if(param.group = 'album') {
			group = ' group by tag_album';

		} else if(param.group = 'dir') {
			group = ' group by dir';
		}
	}

	let sql = "select " + col.join(',') + " from file where {where} {group} order by tag_title asc";

	console.log(where.join(' or '));
	console.log(sql.replace('{where}', where.join(' or ')));

	let stmt = db.prepare(sql.replace('{group}', group).replace('{where}', where.join(' or ')));
	let rows = stmt.all(params);
	res.json(rows);
});

app.use("/playlists.json", function(req, res) {
	let stmt = db.prepare("select * from playlist order by name asc");
	let rows = stmt.all();
	res.json(rows);
});

app.use("/play.json", function(req, res) {
	let param = (Object.keys(req.query).length !== 0 ? req.query : req.body);

	if(param) {
		let fullpath = path.join(param.path, (param.name || ''));
		logger.info('Play from: ' + fullpath);

		player.loadFile(fullpath);
		player.play();
		playstatus = fullpath;

		res.json({
			msg: 'play ' + param.name,
	//		pid: proc.pid
		});

	} else {
		res.json({
			msg: 'Need for parameter "path" and "name".'
		});
	}
});

app.use("/queue.json", function(req, res) {
	let stmt = db.prepare("select * from queue order by id asc");
	let rows = stmt.all();
	res.json(rows);
});

app.use("/insertqueue.json", function(req, res) {
	let param = (Object.keys(req.query).length !== 0 ? req.query : req.body);

	if(param) {
		let fullpath = path.join(param.path, (param.name || ''));

		let stmt = db.prepare("select max(id) as max from queue");
		let count = stmt.all();
		let id = count.max + 1;

		db_insert('queue', {
			id: id,
			path: fullpath
		});

		stmt = db.prepare("select * from queue where id = ?");
		let rows = stmt.all(id);

		res.json(rows);

	} else {
		res.json({});
	}
});

app.use("/deletequeue.json", function(req, res) {
	try {
		let stmt = db.prepare("select id from queue order by id asc limit 1");
		let ret = stmt.get();
		let id = ret.id;

		if(id > 0) {
			db.prepare(`delete from queue where id = ${id}`).run();
		}

		res.json({
			success: true,
			msg: id
		});

	} catch(e) {
		res.json({
			success: false,
			msg: e
		});
	}
});

app.use("/status.json", async function(req, res) {
	let played = await player.getProperty('stream-path');
	let tag = {
		title: '',
		album: '',
		artist: '',
		track: ''
	};

	if(played) {
		let t = await id3read(played);
		tag = t.tags;
	}

	res.json({
		status: playstatus,
		title: tag.title,
		play: {
			title: tag.title,
			album: tag.album,
			artist: tag.artist,
			track: tag.track
		},
		file: await player.getProperty('stream-open-filename'),
		path: await player.getProperty('media-title'),
		duration: await player.getProperty('duration'),
		percentPos: await player.getProperty('percent-pos'),
		timePos: await player.getProperty('time-pos'),
		timeRemaining: await player.getProperty('time-remaining'),
		playtimeRemaining: await player.getProperty('playtime-remaining'),
		playbackTime: await player.getProperty('playback-time')
	});
});

app.use("/stream", async function(req, res) {
	res.setHeader('Content-Type', 'text/event-stream');
	res.setHeader('Connection', 'keep-alive');
	res.setHeader('Cache-Control', 'no-cache');
	res.flushHeaders();

	res.write('\n');
	res.write('event: status\n');
	res.write('data: ' + await player.getProperty('filename') + '\n\n');

	let id = setInterval(async function() {
		let played = await player.getProperty('stream-path');
		let tag = {
			title: '',
			album: '',
			artist: '',
			track: ''
		};

		if(played) {
			let t = await id3read(played);
			tag = t.tags;
		}

		let data = {
			status: playstatus,
			title: tag.title,
			play: {
				title: tag.title,
				album: tag.album,
				artist: tag.artist,
				track: tag.track
			},
			file: await player.getProperty('stream-open-filename'),
			path: await player.getProperty('media-title'),
			duration: await player.getProperty('duration'),
			percentPos: await player.getProperty('percent-pos'),
			timePos: await player.getProperty('time-pos'),
			timeRemaining: await player.getProperty('time-remaining'),
			playtimeRemaining: await player.getProperty('playtime-remaining'),
			playbackTime: await player.getProperty('playback-time')
		};
		res.write('data: ' + JSON.stringify(data) + '\n\n');
		res.flush();

		if(data.percentPos == undefined) {
			res.end();
			return;
		}
	}, 1000);

	req.on('close', () => {
		clearInterval(id);
		res.end('OK');
	});
});

app.use("/stop.json", function(req, res) {
	player.stop();

	res.json({
		msg: 'Stop',
		status: playstatus
	});
});

app.use("/pause.json", function(req, res) {
	player.pause();

	res.json({
		msg: 'Pause',
		status: playstatus
	});
});

app.use("/resume.json", function(req, res) {
	player.resume();

	res.json({
		msg: 'Resume',
		status: playstatus
	});
});

app.use("/togglepause.json", function(req, res) {
	player.togglePause();

	res.json({
		msg: 'Toggle Pause',
		status: playstatus
	});
});

app.use("/loop.json", function(req, res) {
	player.loop();

	res.json({
		msg: 'Loop',
		status: playstatus
	});
});

app.use("/clearloop.json", function(req, res) {
	player.clearLoop();

	res.json({
		msg: 'Clear Loop',
		status: playstatus
	});
});

app.use("/pos.json", function(req, res) {
	player.goToPosition();

	res.json({
		msg: 'Go To Position',
		status: playstatus
	});
});

app.use("/mute.json", function(req, res) {
	player.toggleMute();

	res.json({
		msg: 'Toggle Mute',
		status: playstatus
	});
});


