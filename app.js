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
const chk = require('chokidar');

let app = express();
let bodyParser = require('body-parser');

const db = new sqlite('sowrver.sqlite');
let player = new mpv({
	"verbose": true,
	"audio_only": true
});

let playstatus = '';
let readlibstatus = '';
const queueTmp = "/tmp/sowrver.m3u";
let watcher = {};

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
//	logger.info("queue table is truncate.");
//	db.prepare('delete from queue').run();
	logger.info("Initialize queue file.");
	fs.writeFileSync(queueTmp, "");
	logger.info('Initialize file checker.');
	initChecker();
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

const db_update = function(table, data, where) {

}

const db_delete = function(table, where) {
	if(!where) { return; }

	let col = Object.keys(where);
	let ws = [];

	for(let nm of col) {
		ws.push(nm + ' = ?');
	}

	let sql = 'delete from ' + table + ' where ' + ws.join(' and ');
	let val = Object.values(where);
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


const getPlaylist = async function() {
	return await player.getProperty('playlist');
}

const getM3uStr = async function() {
	let list = await getPlaylist();

	if(!list) { return null; }

	let line = [];
	line.push("#EXTM3U");

	for(let idx = 0, size = list.length; idx < size; idx++) {
		line.push(list[idx].filename);
	}

	return line.join("\n");
}

const saveQueue = async function() {
	let txt = await getM3uStr();

	if(!txt) { return; }

	fs.writeFileSync(queueTmp, txt);
}

const checker = function(p) {
	if(watcher[p]) { return; }

	watcher[p] = chk.watch(p, {
		ignored: /[\/\\]\./,
		persistent: true
	});

	watcher[p].on('change', async function(d) {
		await readFile(d);
	});

	watcher[p].on('unlink', function(d) {
		logger.info('Remove file: ' + d);
		readlibstatus = 'Remove file: ' + d;
		let filename = path.basename(d);;
		let fullpath = path.dirname(d);
		let parent = fullpath.split(path.sep).pop();
		let ext = path.extname(d);

		if(ext == '.m3u') {
			db_delete('playlist', {
				path: parent,
				name: fullpath
			});

		} else {
			db_delete('file', {
				path: fullpath,
				dir: parent,
				name: filename
			});
		}
	});
}

const initChecker = function() {
	let stmt = db.prepare("select * from lib");
	let rows = stmt.all();

	if(rows) {
		for(let nm of rows) {
			checker(nm.path);
		}
	}
}

const readFile = async function(d) {
	let filename = path.basename(d);
	let fullpath = path.dirname(d);
	let parent = fullpath.split(path.sep).pop();
	let ext = path.extname(d);

	let stmt = db.prepare("select * from file where path = ? and dir = ? and name = ?");
	let dat = stmt.all([fullpath, parent, filename]);
	
	if(!dat || dat.length >= 1) { return; }

	logger.info('Read file: ' + d);
	readlibstatus = 'Read file: ' + d;

	if(ext == '.m3u') {
		db_insert('playlist', {
			path: parent,
			name: fullpath
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
			return;
		}

		//console.log(path.join(nm.path, list[0]));console.log(tag);console.log(list[0]);console.log(parent);console.log(nm);
		let bin = new Uint8Array(0);
		if(tag.picture) {
			bin = new Uint8Array(tag.picture.data);
		}

		db_insert('file', {
			path: fullpath,
			dir: parent,
			name: filename,
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
	}
}

const readLib = async function(rows) {
	if(!rows) {
		return {
			readFile: null,
			count: 0,
			targets: rows
		};
	}

	let count = 0;
	let rFile = 0;

	for(let nm of rows) {
		let list = rfiles(nm.path);
		rFile += list.length;

		for(let d of list) {
			count++;
			await readFile(d);continue;
		}
	}

	readlibstatus = '';

	return {
		readFile: rFile,
		count: count,
		targets: rows
	};
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

		if(fs.existsSync(path)) {
			let stmt = db.prepare("select count(*) as count from lib");
			let dat = stmt.all();
			let id = dat[0].count + 1;

			db_insert('lib', {
				id: id,
				path: path,
				recursive: recursive
			});

			stmt = db.prepare("select * from lib where id = ?");
			let rows = stmt.all(id);
			readLib(rows);

			res.json(rows);

		} else {
			res.json({
				msg: 'Path not found.'
			});
		}

	} else {
		res.json({
			msg: 'Parameter not found.'
		});
	}
});

app.use("/deletelib.json", function(req, res) {
	let param = (Object.keys(req.query).length !== 0 ? req.query : req.body);

	if(param) {
		let id = param.id;

		if(id) {
			let stmt = db.prepare("select * from lib where id = ?");
			let rows = stmt.all(id);
			let path = rows[0].path;
			let params = [path + '%'];

			stmt = db.prepare("select count(*) as count from file where path like = ?");
			let dat = stmt.all(params);

			db.prepare(`delete from file where path like ?`).run(params);

			res.json({
				id: id,
				fileCount: dat[0].count
			});

		} else {
			res.json({
				msg: 'ID not found.'
			});
		}

	} else {
		res.json({
			msg: 'Parameter not found.'
		});
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
	let ret = {};

	if(rows) {
		db.prepare('delete from file').run();
		db.prepare('delete from playlist').run();

		ret = readLib(rows);
	}

	res.json(ret);

});

app.use("/readlibstatus", async function(req, res) {
	res.setHeader('Content-Type', 'text/event-stream');
	res.setHeader('Connection', 'keep-alive');
	res.setHeader('Cache-Control', 'no-cache');
	res.flushHeaders();

	res.write('\n');
	res.write('event: readlibstatus\n');
	res.write('data: Initialize\n\n');

	let id = setInterval(async function() {
		if(readlibstatus == '' || readlibstatus == undefined || readlibstatus == null) {
		res.write('data: Finalize\n\n');
			res.end();
			clearInterval(id);
			return;
		}

		
		res.write('data: ' + readlibstatus + '\n\n');
		res.flush();
	}, 1000);

	req.on('close', () => {
		clearInterval(id);
		res.end('OK');
	});
});


app.use("/musics.json", function(req, res) {
	let col = ['path', 'dir', 'name', 'like', 'tag_title', 'tag_album', 'tag_artist', 'tag_genre', 'tag_track', 'tag_year', 'tag_comment'];
	let group = '';
	let where = [];
	let params = [];
	let param = (Object.keys(req.query).length !== 0 ? req.query : req.body);
	let page = '';
	let count = 0;

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

	if(param && param.limit && param.offset) {
		let sql = "select count(*) as count from file where {where} {group} order by tag_title asc";
		let stmt = db.prepare(sql.replace('{group}', group).replace('{where}', where.join(' or ')));
		let rows = stmt.all(params);
		count = rows[0].count;

		page = ' limit ? offset ?';
		params.push(param.limit);
		params.push(param.offset);
	}

	let sql = "select " + col.join(',') + " from file where {where} {group} order by tag_title asc" + page;

	console.log(where.join(' or '));
	console.log(sql.replace('{where}', where.join(' or ')));
	console.log(params);

	let stmt = db.prepare(sql.replace('{group}', group).replace('{where}', where.join(' or ')));
	let rows = stmt.all(params);
	let ret;

	if(param && param.limit && param.offset) {
		ret = {
			count: count,
			rows: rows
		};
	} else {
		ret = rows;
	}

	res.json(ret);
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

		player.load(fullpath);
		player.play();
		playstatus = fullpath;
		saveQueue();

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

app.use("/loadplaylist.json", function(req, res) {
	let param = (Object.keys(req.query).length !== 0 ? req.query : req.body);

	if(param) {
		let fullpath = path.join(param.path, (param.name || ''));
		logger.info('Playlists from: ' + fullpath);

		player.loadPlaylist(fullpath);
		player.play();
		playstatus = fullpath;
		saveQueue();

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

app.use("/saveplaylist.json", async function(req, res) {
	let param = (Object.keys(req.query).length !== 0 ? req.query : req.body);

	if(param) {
		let filepath = param.path;
		logger.info('Save Playlists from: ' + filepath);
		let txt = await getM3uStr();

		if(txt) {
			try {
				fs.writeFileSync(filepath, txt);

				res.json({
					success: true,
					msg: 'Save Playlist: ' + filepath
				});

			} catch(e) {
				logger.error('ID3tag error: ' + e);
				res.json({
					success: false,
					msg: 'Save error: ' + e
				});
			}

		} else {
			res.json({
				success: false,
				msg: 'Playlist is empty.'
			});
		}

	} else {
		res.json({
			msg: 'Need for parameter "filename".'
		});
	}
});

app.use("/queue.json", async function(req, res) {
	res.json(await getPlaylist());
//	let stmt = db.prepare("select * from queue order by id asc");
//	let rows = stmt.all();
//	res.json(rows);
});

app.use("/insertqueue.json", async function(req, res) {
	let param = (Object.keys(req.query).length !== 0 ? req.query : req.body);

	if(param) {
		let fullpath = path.join(param.path, (param.name || ''));
		player.load(fullpath, "append");
		saveQueue();
/*
		let stmt = db.prepare("select max(id) as max from queue");
		let count = stmt.all();
		let id = count.max + 1;

		db_insert('queue', {
			id: id,
			path: fullpath
		});

		stmt = db.prepare("select * from queue where id = ?");
		let rows = stmt.all(id);
*/
		res.json(await getPlaylist());

	} else {
		res.json({});
	}
});

app.use("/deletequeue.json", async function(req, res) {
	let param = (Object.keys(req.query).length !== 0 ? req.query : req.body);
	let id = -1;
	let idx = -1;

	if(param) {
		id = Number(param.id);

		if(id >= 0) {
			let list = await getPlaylist();
			idx = 0;

			for(let size = list.length; idx < size; idx++) {
				if(list[idx].id == id) {
					player.playlistRemove(idx);
					break;
				}
			}
		}

		saveQueue();
	}

	res.json({
		deleteIdd: id,
		index: idx
	});

	/*	try {
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
	}*/
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
		played: played,
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
		playbackTime: await player.getProperty('playback-time'),
		playlistPos: await player.getProperty('playlist-pos'),
		playlistPlayingPos: await player.getProperty('playlist-playing-pos'),
		playlistCount: await player.getProperty('playlist-count'),
		playlist: await player.getProperty('playlist')
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
	saveQueue();

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

app.use("/resume.json", async function(req, res) {
	let pos = await player.getProperty('playlist-pos');

	if(pos == -1) {
		let list = await getPlaylist();

		if(list) {
			let fullpath = list[0].filename;
			player.loadPlaylist(queueTmp);
			player.play();
			playstatus = fullpath;

			res.json({
				msg: 'Play',
				status: playstatus
			});

		} else {
			res.json({
				msg: 'Empty',
				status: playstatus
			});
		}

	} else {
		player.resume();

		res.json({
			msg: 'Resume',
			status: playstatus
		});
	}
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

app.use("/next.json", function(req, res) {
	player.next();

	res.json({
		msg: 'Next',
		status: playstatus
	});
});

app.use("/prev.json", function(req, res) {
	player.prev();

	res.json({
		msg: 'Prev',
		status: playstatus
	});
});

app.use("/volume.json", function(req, res) {
	let param = (Object.keys(req.query).length !== 0 ? req.query : req.body);
	let vol = 50;

	if(param) {
		let vol = Number(param.volume);
		player.volume(vol);
	}

	res.json({
		msg: 'Volume',
		valulue: vol,
		status: playstatus
	});
});

app.use("/checker.json", function(req, res) {
	res.json({
		msg: 'Checker',
		status: watcher
	});
});

