create table lib(
    id      integer primary key not null,
    path    text not null,
    recursive   integer not null default 0,
    filecount   integer not null default 0,
    create_at timestamp not null default (datetime('now', 'localtime')),
    update_at timestamp not null default (datetime('now', 'localtime'))
);
create index lib_id on lib(id);
create index lib_path on lib(path);

create table file(
    path    text not null,
    dir    text not null,
    name    text not null,
    like    integer not null default 0,
    tag_title   text,
    tag_album	text,
    tag_artist	text,
    tag_genre	text,
    tag_track	text,
    tag_year	text,
    tag_comment text,
    tag_cover   blob
);
create index file_path on file(path);
create index file_dir on file(dir);
create index file_name on file(name);
create index file_like on file(like);
create index file_fullpath on file(path, name);
create index file_album on file(tag_album);

create table playlog(
    path    text not null,
    name    text not null,
    create_at timestamp not null default (datetime('now', 'localtime'))
);
create index log_path on playlog(path);
create index log_name on playlog(name);
create index log_fullpath on playlog(path, name);
create index log_date on playlog(create_at);

create table playlist(
    path    text not null,
    name    text not null
);
create index playlist_path on playlist(path);
create index playlist_name on playlist(name);
