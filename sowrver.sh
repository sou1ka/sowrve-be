#!/bin/sh

DIR=$(cd $(dirname $0); pwd)

if [ ${1} = "start" ]; then
	mpv --idle &
	nohup node ${DIR}/app.js & &>/dev/null
elif [ ${1} = "stop" ]; then
	MPVID=`pidof mpv`
	PID=`pidof node ${DIR}/app.js`
	kill -9 ${MPVID}
	kill -9 ${PID}
else
	MPVID=`pidof mpv`
	PID=`pidof node ${DIR}/app.js`
	echo PATH ${DIR}
	echo MPV PID ${MPVID}
	echo APP PID ${PID}
fi
