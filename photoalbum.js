#!/usr/bin/node

/* {{{ Globals */

var express = require('express'),
    util = require('util'),
    os = require('os'),
    fs = require('fs'),
    path = require('path'),
    im = require('imagemagick'),
    crypto = require('crypto'),
    mime = require('mime'),
    url = require('url'),
    Q = require('q'),
    auth = require('http-auth'),
    multipart = require('connect-multiparty'),
    favicon = require('express-favicon'),
    methodOverride = require('method-override'),
    http = require('http'),
    archiver = require('archiver');

var app = express();
var multipartMiddleware = multipart();

//var throttle = require('throttle');
var throttle = false;

var DEFAULT_HTTP_PORT = 8080;
var NB_WORKERS = 10;

var cfgPath;

var editorFiles = [
    'editor.html',
    'photoalbum.editor.js',
    'photoalbum.editor.css',
    'jquery-ui.min.js',
    'jquery-ui.min.css',
    'moment.js',
    'moment-timezone.js',
    'moment-timezone-data.js',
    'edit.png',
    'del.png',
    'list.png',
    'save.png'
];
var indexFiles = [
    'index.html',
    'photoalbum.css',
    'prev.png',
    'next.png',
    'play.png',
    'pause.png',
    'loading.gif',
    'jquery.viewport.js',
    'photoalbum.web.js',
    'brickwall.png'
];
var bothFiles = [
    'jquery.min.js',
    'tipsy.js',
    'tipsy.css',
    'markdown.js',
    'black_paper.png',
    'thumbs.png',
    'pos.png',
    'time.png',
    'leaflet.css',
    'leaflet.js',
    'gpx.js',
    'elevation.js',
    'elevation.css',
    'd3.min.js',
    'Makefile',
    'marker-icon.png',
    'marker-shadow.png',
    'pin-icon-start.png',
    'pin-icon-end.png',
    'pin-shadow.png'
];

var directories = [
    'large',
    'thumb',
    'full'
];

/* }}} */
/* {{{ Utils */

var keys = function(o) {
    if (typeof this !== 'object') {
        throw new TypeError('Object.keys called on non-object');
    }
    var ret = [];
    var p;
    for (p in o) {
        if (Object.prototype.hasOwnProperty.call(o, p)) {
            ret.push(p);
        }
    }
    return ret;
};

var md5 = function(path, onDone) {
    var md5sum = crypto.createHash('md5');
    var s = fs.ReadStream(path);
    s.on('data', function(d) {
        md5sum.update(d);
    });

    s.on('end', function() {
        var d = md5sum.digest('hex');
        onDone(d);
    });
};

var getJSONFromPath = function(path, onDone) {
    var data = fs.readFile(path, function(err, data) {
        if (err) {
            throw (err);
        }
        var cfg = JSON.parse(data);
        onDone(cfg);
    });
};

var saveCfg = function(cfgPath, cfg) {
    return new Promise(function (fulfill, reject) {
        fs.writeFile(cfgPath, JSON.stringify(cfg, null, 4), function(err) {
            if (err) { return reject(err); }
            return fulfill("OK")
        });
    });
};

var genLegend = function(legend) {
    if (legend) {
        if (typeof legend === "string") {
            return legend;
        } else {
            return legend.join('\n');
        }
    }
    return undefined;
};

var genHtmlFile = function(username, cfg, source, onDone) {
    fs.readFile(source, {
        encoding: 'UTF-8'
    }, function(err, data) {
        if (err) {
            throw err;
        }
        if (username !== '') data = data.replace(/%%NAME%%/g, username);
        data = data.replace(/%%TITLE%%/g, cfg.title || '');
        data = data.replace(/%%LANG%%/g, cfg.lang || 'en');
        getJSONFromPath('translations.json', function(translations) {
            data = data.replace(/%%TRANSLATIONS%%/g,
                JSON.stringify(translations[cfg.lang] || {},
                    null, 1));
            var langs = ["en"].concat(keys(translations));
            data = data.replace(/%%AVAILABLE_LANGS%%/g,
                JSON.stringify(langs, null, 1));
            data = data.replace(/%%CFG%%/g,
                JSON.stringify(cfg, null, 1));

            var _ = function(str) {
                return translations[str] || str;
            };
            data = data.replace(/%%GENERATE_CFG%%/g, _('Generate config.json'));
            data = data.replace(/%%EDIT_TITLE%%/g, _('Title of the album: '));
            data = data.replace(/%%OUT_DIR%%/g, _('Output directory of the album: '));
            data = data.replace(/%%SELECT_LANG%%/g, _('Language of the album: '));
            data = data.replace(/%%SELECT_TIMEZONE%%/g, _('Select the timezone the images where taken in: '));
            data = data.replace(/%%ADD_PAGE%%/g, _('Add page'));
            onDone(data);
        });
    });
};

/* }}} */
/* {{{ Setup */

var setup = function(cfg, isEditor) {

    var workHtmlFile = function(filename) {
        var source = path.join('htdocs', filename);
        genHtmlFile('', cfg, source, function(data) {
            if (!fs.existsSync(cfg.out)) { fs.mkdir(cfg.out) }
            var dest = path.join(cfg.out, filename);
            fs.writeFile(dest, data, function(err) {
                if (err) {
                    throw (err);
                }
            });
        });
    };


    var copyFilesList = function(l) {
        var i;
        for (i in l) {
            var filename = l[i];

            /* TODO: check file dates, do 'à la' make */
            var src = path.join('htdocs', filename);
            var dst = path.join(cfg.out, filename);
            var srcStream = fs.createReadStream(src);
            var dstStream = fs.createWriteStream(dst);

            srcStream.pipe(dstStream);
        }
    };

    if (isEditor) {
        copyFilesList(editorFiles);
        workHtmlFile('editor.html');
    } else {
        copyFilesList(indexFiles);
        workHtmlFile('index.html');
    }
    copyFilesList(bothFiles);

    /* mkdir */
    var i;
    for (i in directories) {
        (function() {
            var dir = directories[i];
            var p = path.join(cfg.out, dir);
            fs.stat(p, function(err) {
                if (err) {
                    fs.mkdir(p);
                }
            });
        })();
    }
};

/* }}} */
/* {{{ genJSON */

var genJSON = function(cfg, images, onDone) {
    var l = [];
    var i;
    var errFn = function(err) {
        if (err) {
            throw (err);
        }
    };
    for (i = 0; i < images.length; i++) {
        var o = {
            images: []
        };
        var j;
        for (j = 0; j < images.length; j++) {
            o.images.push(images[j]);
        }
        var jsonPath = path.join(cfg.out, 'images.json');
        fs.writeFile(jsonPath, 'var images = ' +
            JSON.stringify(o.images, null, 4) + ';',
            errFn);
    }
    if (onDone) {
        onDone();
    }
};

/* }}} */
/* {{{ genThumbs */

var genOneThumbnail = function(cfg, pos, img, images, onDone) {
    if (img.type === 'page') {
        images[pos] = img;
        onDone();
        return;
    }
    fs.stat(img.path, function(err, stat) {
        if (err) {
            console.error(err);
            onDone();
            return;
        }

        var thumbPath = path.join(cfg.out, 'thumb', img.md5 + path.extname(img.path));
        var resize = function() {
            var o = {
                width: 256,
                srcPath: img.path,
                strip: true,
                dstPath: thumbPath
            };
            im.resize(o, function(err, stdout, stderr) {
                if (err) {
                    throw err;
                }
                im.identify(o.dstPath, function(err, features) {
                    if (err) {
                        throw err;
                    }

                    img.th_w = features.width;
                    img.th_h = features.height;

                    var o = {
                        l: genLegend(img.legend),
                        md: genMetadata(img),
                        md5: img.md5,
                        l_w: img.l_w,
                        l_h: img.l_h,
                        th_w: img.th_w,
                        th_h: img.th_h,
                        ext: path.extname(img.path)
                    };
                    images[pos] = o;
                    return onDone();
                });
            });
        };
        fs.exists(path.join(cfg.out, 'thumb', img.md5 + path.extname(img.path)),
            function(exists) {
                if (exists) {
                    if (!img.th_w || !img.th_h) {
                        im.identify(thumbPath, function(err, features) {
                            if (err) {
                                throw err;
                            }

                            img.th_w = features.width;
                            img.th_h = features.height;
                        });
                    }
                    var o = {
                        l: genLegend(img.legend),
                        md: genMetadata(img),
                        md5: img.md5,
                        l_w: img.l_w,
                        l_h: img.l_h,
                        th_w: img.th_w,
                        th_h: img.th_h,
                        ext: path.extname(img.path)
                    };
                    images[pos] = o;
                    return onDone();
                } else {
                    return resize();
                }
            });
    });
};

var genThumbs = function(cfg, onEnd) {
    var done = 0;
    var images = [];

    var dealImage = function(cfg, pos) {
        var img = cfg.images[pos];

        var finish = function() {
            done++;

            if (done < cfg.images.length) {
                return dealImage(cfg, done);
            } else if (done == cfg.images.length) {
                return onEnd(images);
            }
        };

        if (!img) { console.error("Got no image: " + pos ); return finish(); }
        genOneThumbnail(cfg, pos, img, images, finish);
    };

    dealImage(cfg, 0);
};

/* }}} */
/* {{{ copyFull */

var copyIfNotExits = function(src, dst, onDone) {
    fs.exists(dst, function(exists) {
        if (exists) {
            if (onDone) {
                onDone();
            }
            return;
        }

        var srcStream = fs.createReadStream(src);
        var dstStream = fs.createWriteStream(dst);

        if (onDone) {
            dstStream.on('close', onDone);
        }
        srcStream.pipe(dstStream);
    });
};

var copyFull = function(cfg, onDone) {
    var done = 0;
    var worker;

    worker = function(pos) {
        var img = cfg.images[pos];
        if (!img) {
            return;
        }
        var finish = function(pos) {
            done++;
            if (pos + NB_WORKERS < cfg.images.length) {
                worker(pos + NB_WORKERS);
            } else if (done == cfg.images.length) {
                onDone();
            }
        };
        if (img.type === 'page') {
            finish(pos);
        } else {
            copyIfNotExits(img.path,
                path.join(cfg.out, 'full', img.md5 + path.extname(img.path)),
                function() {
                    finish(pos);
                });
        }
    };

    for (i = 0; i < NB_WORKERS; i++) {
        worker(i);
    }

};

/* }}} */
/* {{{ processMetadata */

var processGPS = function(exif) {
    var pos = {};
    if (!exif.gpsVersionID) {
        return undefined;
    }
    if (exif.gpsVersionID === '2, 3, 0, 0' || exif.gpsVersionID === '2.3.0.0') {
        if (!exif.gpsLatitude || !exif.gpsLatitudeRef ||
            !exif.gpsLongitude || !exif.gpsLongitudeRef) {
            return undefined;
        }
        var t;
        t = exif.gpsLatitude.split(', ');

        var conv = function(str) {
            var t = str.split('/');
            if (t.length == 2) {
                return parseInt(t[0]) / parseInt(t[1]);
            } else {
                return parseInt(t[0]);
            }
        };
        var degree;
        var lat = conv(t[0]) + conv(t[1]) / 60 + conv(t[2]) / 3600;
        if (exif.gpsLatitudeRef == 'S') {
            lat = -lat;
        }
        t = exif.gpsLongitude.split(',');
        var lon = conv(t[0]) + conv(t[1]) / 60 + conv(t[2]) / 3600;
        if (exif.gpsLongitudeRef == 'W') {
            lon = -lon;
        }

        pos.lat = lat;
        pos.lon = lon;
    }

    return pos;
};

var processMetadata = function(metadata) {
    var md = {};

    if (!metadata || !metadata.exif)
        return md;

    var exif = metadata.exif;

    if (exif.dateTime) {
        if (exif.dateTimeOriginal && exif.dateTimeOriginal < exif.dateTime) {
            md.dateTime = exif.dateTimeOriginal.toJSON();
        } else {
            md.dateTime = exif.dateTime.toJSON();
        }
        md.showDate = true;
    } else if (exif.dateTimeOriginal) {
        md.dateTime = exif.dateTimeOriginal.toJSON();
        md.showDate = true;
    }

    md.position = processGPS(exif);
    if (md.position) {
        md.showGPS = true;
    }

    return md;
};

var genMetadata = function(img) {
    var md = {};

    if (!img.metadata) {
        return md;
    }

    if (img.metadata.dateTimeStr && img.metadata.showDate) {
        md.dateStr = img.metadata.dateTimeStr;
    }

    if (img.metadata.position && img.metadata.showGPS &&
        img.metadata.position.lat && img.metadata.position.lon) {
        md.pos = {};
        md.pos.lat = img.metadata.position.lat.toFixed(6);
        md.pos.lon = img.metadata.position.lon.toFixed(6);
    }

    return md;
};

/* }}} */
/* {{{ doRender */

var doRender = function(cfg, doGenJSON, onDone) {
    var i;
    var done = 0;
    var images = [];

    var dealImage = function(cfg, pos, onDone) {
        var img = cfg.images[pos];
        if (!img) {
            return;
        }

        var finish = function() {
            done++;
            if (pos + NB_WORKERS < cfg.images.length) {
                dealImage(cfg, pos + NB_WORKERS, onDone);
            } else if (done == cfg.images.length) {
                onDone();
            }
        };

        if (img.type === 'page') {
            images[pos] = img;
            finish();
            return;
        }

        var full = function() {
            var dest = path.join(cfg.out, 'full', img.md5 + path.extname(img.path));

            copyIfNotExits(img.path, dest, finish);
        };

        var large = function() {
            var action = function() {
                var o = {
                    srcPath: img.path,
                    dstPath: path.join(cfg.out, 'large', img.md5 + path.extname(img.path)),
                    height: 768,
                    strip: true,
                    progressive: true
                };
                var d = 1.0;
                while (img.height / d > 700) {
                    d *= 2;
                }
                if (d > 1) {
                    d /= 2;
                }
                o.height = img.height / d;
                o.width = img.width / d;

                fs.exists(o.dstPath, function(exists) {
                    if (exists) {
                        full();
                    } else {
                        im.resize(o, function(err, stdout, stderr) {
                            if (err) {
                                throw err;
                            }
                            im.identify(o.dstPath, function(err, features) {
                                if (err) {
                                    throw err;
                                }

                                img.l_w = features.width;
                                img.l_h = features.height;
                                images[pos].l_w = img.l_w;
                                images[pos].l_h = img.l_h;

                                full();
                            });
                        });
                    }
                });
            };
            if (img.width && img.height) {
                action();
            } else {
                im.identify(img.path, function(err, features) {
                    if (err) {
                        throw err;
                    }

                    img.width = features.width;
                    img.height = features.height;

                    action();
                });
            }

        };

        genOneThumbnail(cfg, pos, img, images, large);
    };


    var itsOver = function() {
        if (doGenJSON) {
            genJSON(cfg, images);
        }
        onDone();
    };
    for (i = 0; i < NB_WORKERS; i++) {
        dealImage(cfg, i, itsOver);
    }
};


function dateToStr(date) {
        var day = (date.getDate() < 10 ? "0" + date.getDate() : date.getDate());
        var hours = (date.getHours() < 10 ? "0" + date.getHours() : "" + date.getHours());
        var minutes = (date.getMinutes() < 10 ? "0" + date.getMinutes() : "" + date.getMinutes());
        var seconds = (date.getSeconds() < 10 ? "0" + date.getSeconds() : "" + date.getSeconds());
        return "" + date.getFullYear() + (date.getMonth() + 1) + day + "_" + hours + minutes + seconds;
}

function getDateTimeFilename(imagepath) {
    return new Promise(function (resolve, reject) {
        im.readMetadata(imagepath, function (err, metadata) {
            var date, exif;
            if (err) return reject(err);

            exif = metadata.exif;
            if (exif != undefined) {
                date = (exif.dateTime || exif.dateTimeDigitized || exif.dateTimeOriginal);
                return resolve(dateToStr(new Date(date)));
            } else {
                //md5 filename
                fs.readFile(imagepath, function (err, data) {
                    var checksum;
                    if (err) { return reject(err); }
                    checksum = crypto.createHash('md5').update(data).digest('hex');
                    return resolve(checksum);
                })
            }
        });
    })
}

/* }}} */
/* {{{ addImages */

var addImages = function(cfg, cfgPath, images, inPath) {

    return new Promise(function (fulfill, reject) {

        var md5Dict = {};
        var i;
        for (i in cfg.images) {
            var img = cfg.images[i];
            md5Dict[img.md5] = true;
        }
        var original_length = cfg.images.length;

        var done = 0;
        var checkImage;

        checkImage = function(f) {
            if (f >= images.length) { return; }

            var onDone = function () {
                ++done;

                if (done == images.length) {
                    console.log('photo album now has ' + cfg.images.length + ' images\n');

                    if (inPath) {
                        cfg.images.sort(function(imgA, imgB) {
                            if (imgA.path < imgB.path) {
                                return -1;
                            } else if (imgA.path > imgB.path) {
                                return 1;
                            } else {
                                return 0;
                            }
                        });
                    }
                    return fulfill(done);
                } else {
                    return checkImage(done);
                }
            };

            var p = (inPath) ? path.join(inPath, images[f]) : images[f];
            var type = mime.lookup(p);
            if (type.indexOf('image') !== 0) {
                onDone();
                return;
            }

            fs.stat(p, function(err, stat) {
                if (err) {
                    console.error(err);
                    onDone();
                    return;
                }
                im.readMetadata(p, function(err, metadata) {
                    if (err) {
                        console.error(err);
                        onDone();
                        return;
                    }
                    metadata = processMetadata(metadata);
                    md5(p, function(hex) {
                        if (!md5Dict[hex]) {
                            var o = {
                                path: p,
                                legend: '',
                                md5: hex,
                                metadata: metadata,
                                mtime: stat.mtime.getTime()
                            };
                            cfg.images[f + original_length] = o;
                            md5Dict[hex] = true;
                        }
                        return onDone();
                    });
                });
            });
        };


        checkImage(0);
    })
};
/* }}} */
/* {{{ genConfig */

var genConfig = function(inPath, cfgPath, outDirectory) {
    var json = {
        images: [],
        out: outDirectory || 'out/',
        title: 'Pictures',
        lang: 'en'
    };

    fs.readdir(inPath, function(err, dirs) {
        if (err) {
            throw err;
        }

        addImages(json, cfgPath, dirs, inPath)
            .then(function() {
                fs.stat(json.out, function(err, stats) {
                    if (err) {
                        fs.mkdir(json.out);
                    }
                    console.log("you can now run '" + process.argv[1] + " editor " +
                        cfgPath + "' to generate an editor\n");
                });
            });
    });
};

/* }}} */
/* {{{ cleanup */

var cleanup = function(cfg) {
    var images = {};
    var i;
    for (i in cfg.images) {
        var img = cfg.images[i];
        if (img.md5) {
            images[img.md5 + path.extname(img.path)] = true;
        }
    }

    var cleanupDir = function(allowedFiles, dir) {
        var dirPath = (dir) ? path.join(cfg.out, dir) : cfg.out;
        fs.readdir(dirPath, function(err, files) {
            if (err) {
                throw err;
            }
            var i;
            for (i in files) {
                (function() {
                    var filename = files[i];
                    if (!allowedFiles[filename]) {
                        var f = path.join(dirPath, filename);
                        fs.stat(f, function(err, stats) {
                            if (err) {
                                throw err;
                            }
                            if (stats.isDirectory()) {
                                console.err(f + ' is a directory that should' +
                                    ' be cleaned up');
                            } else {
                                fs.unlink(f, function(err) {
                                    if (err) {
                                        throw err;
                                    }
                                });
                            }
                        });
                    }
                })();
            }
        });
    };

    cleanupDir(images, 'full');
    cleanupDir(images, 'large');
    cleanupDir(images, 'thumb');


    fs.readdir('htdocs', function(err, files) {
        if (err) {
            throw err;
        }
        var i;
        var allowedFiles = {};
        var setupAllowedFiles = function(l) {
            for (i in l) {
                var filename = l[i];
                allowedFiles[filename] = true;
            }
        };
        setupAllowedFiles(indexFiles);
        setupAllowedFiles(bothFiles);
        setupAllowedFiles(directories);

        cleanupDir(allowedFiles);
    });
};

moveFiles = function(files, callback) {
    function moveFiles_real (idx, newFiles) {
        var filename = files[idx].path;

        getDateTimeFilename(filename).then(function (val) {
            var newFilename = val + path.extname(filename);
            newFiles.push(__dirname + "/img/" + newFilename);

            fs.rename(filename, __dirname + "/img/" + newFilename, function (err) {
                if (err) return console.error(err);

                if (idx + 1 >= files.length) {
                    return callback(newFiles);
                } else {
                    return moveFiles_real(idx + 1, newFiles);
                }
            });
        });

    }

    moveFiles_real(0, []);
}

clearDir = function (directory) {
    return new Promise(function (fulfill, reject) {
        fs.readdir(directory, function (err, files) {
            var i = 0;
            if (err) { return reject(err); }

            for (var a in files) {
                // Note: it is ok to use unlinkSync here, since clearDir is only called very rarely and
                // usually just when using "node photoalbum.js reset config_name"
                fs.unlinkSync(path.join(directory, files[a]));
                i++;
            }            

            return fulfill(i);
        })
    });
}

/* }}} */
/* {{{ server */

var server = function(cfg, cfgPath) {
    var httpSimple = function(code, response) {
        response.writeHead(code, {
            'Content-Type': 'text/html'
        });
        response.end('<h1>' + http.STATUS_CODES[code] + '</h1>');
    };

    var serveStaticFile = function(filePath, response) {

        fs.stat(filePath, function(err, stat) {
            if (err) {
                httpSimple(404, response);
                return;
            }
            //console.log("serving " + filePath);

            var type = mime.lookup(filePath);
            response.writeHead(200, {
                'Content-Type': type,
                'Content-Length': stat.size
            });
            var readStream = fs.createReadStream(filePath);
            if (throttle && filePath.indexOf('large') !== -1 && filePath.indexOf('.jpg') == filePath.length - 4) {
                var lim = new throttle(3000);
                readStream.pipe(lim).pipe(response);
            } else {
                readStream.pipe(response);
            }
        });
    };

    var post_handler = function (request, response) {
        urlParts = url.parse(request.url, false);

        switch (urlParts.pathname) {

            case '/save':
                var data = "";
                request.on('data', function(chunk) {
                    data += chunk;
                });
                request.on('end', function() {
                    httpSimple(200, response);
                    fs.writeFile(cfgPath, data, function(err) {
                        if (err) {
                            throw (err);
                        }
                    });
                });
                return;

            case '/upload':

                moveFiles(request.files.image, function (files) {
                    // generate, render, etc. ...

                    getJSONFromPath(args[1], function(cfg) {

                        addImages(cfg, args[1], files).then(function () {
                            setup(cfg, false);

                            saveCfg(args[1], cfg).then(function (val) {
                                genThumbs(cfg, function () {
                                    setup(cfg, true);

                                    copyFull(cfg, function() {
                                        saveCfg(args[1], cfg);

                                        doRender(cfg, true, function() {
                                            saveCfg(args[1], cfg);    
                                            return httpSimple(200, response);
                                        });
                                    });
                                });
                            }).catch(function (err) {
                                console.error("Could not save " + args[1] + "(" + err + ")")
                            })
                        }).catch(function (err) {
                            console.error("[addImages] failure. " + err)
                        });
                    });
                })

                return;

            default:
                httpSimple(501, response);
                return;
        }

        return httpSimple(501, response);
    }

    var get_handler = function(request, response) {
        var urlParts;
        if (request.method === 'GET') {
            urlParts = url.parse(request.url, false);
            switch (urlParts.pathname) {
                case '/editor.html':
                    /* regenerate editor.html on the fly */
                    var source = 'htdocs/editor.html';
                    genHtmlFile(request.user, cfg, source, function(data) {
                        var buf = Buffer(data);
                        response.writeHead(200, {
                            'Content-Type': 'text/html',
                            'Content-Length': buf.length
                        });
                        response.end(buf);
                    });
                    break;

                case '/cfg.json':
                    serveStaticFile(cfgPath, response);
                    break;

                case '/index.html':
                case '/':
                    var source = 'htdocs/index.html';
                    genHtmlFile(request.user, cfg, source, function(data) {
                        var buf = Buffer(data);
                        response.writeHead(200, {
                            'Content-Type': 'text/html',
                            'Content-Length': buf.length
                        });
                        response.end(buf);
                    });                    
                    break;

                case '/uploadForm':

                    response.writeHead(200, {
                        'Content-Type': 'text/html'
                    });

                    response.end("OK");
                    break;

                case '/logout':
                    //delete request.user;
                    response.statusCode = 401; // Force them to retry authentication
                    response.setHeader('WWW-Authenticate', 'Basic realm="Protected Gallery"');

                    //response.statusCode = 403;   // or alternatively just reject them altogether with a 403 Forbidden

                    response.end('<html><body>Successfully logged out!</body></html>');
                    // http authorisation: basic [base64 ...]
                    break;

                case '/download':
                    if (!fs.existsSync("download/")) {
                        fs.mkdir("download");
                    }

                    getJSONFromPath(args[1], function (cfg) {
                        var zip = archiver('zip') // or archiver('zip', {});
                        var out_filename = __dirname + '/download/' + dateToStr(new Date()) + '.zip';
                        var output = fs.createWriteStream(out_filename);
                        var xpath = path.join(cfg.out, "/full/");
                        zip.pipe(output);                        

                        fs.readdir(xpath, function (err, files) {
                            var filepath;

                            for (var a in files) {
                                filepath = path.join(__dirname, xpath, files[a]);
                                zip.append(fs.createReadStream(filepath), { name: files[a] });
                            }

                            console.log("Creating " + out_filename);
                            zip.finalize();

                            setTimeout(function () {
                                return response.download(out_filename);
                            }, 4000);
                        })

                    });

                    return;

                default:
                    serveStaticFile(path.join(cfg.out, urlParts.pathname), response);
                    break;
            }
        } else {
            httpSimple(501, response);
        }
    };

    //console.log( __dirname + "/users.htdigest");
    
    var http_authentification = auth.digest({
            realm: "Protected Gallery",
            //algorithm: 'MD5-sess',
            file: __dirname + "/users.htdigest"

        } /*, function (username, callback) {
            console.log(username);
            var json = getJSONFromPath("login.json", function (d) {
                var str;
                for (var a in d.logins) {
                    if (username == d.logins[a].username) {
                        str = d.logins[a].password
                        return callback(str)
                    }
                }

                return callback();
            });
        }
        */
    );

    //http.createServer(http_authentification, handler).listen(DEFAULT_HTTP_PORT);

    app.set('port', DEFAULT_HTTP_PORT);
    app.use(favicon(__dirname + "/favicon.ico"));
    app.use(auth.connect(http_authentification));
    app.use(methodOverride());

    app.get('*', get_handler);
    app.post('*', multipartMiddleware, post_handler);

    app.listen(app.get('port'), function () {
        console.log('Server running at http://localhost:' + app.get('port') + '/' +
            '\neditor available at http://localhost:' + app.get('port') +
            '/editor.html');
    });
};

/* }}} */
/* {{{ main */

var usage = function() {
    console.log("usage: photoalbum command\n\n" +
        "command is one of the following:\n" +
        "config input_directory output_config_file [output_directory]\n" +
        "    generate a configuration files about files in input_directory\n" +
        "editor config_file\n" +
        "    generate an editor.html file in output directory\n" +
        "server config_file\n" +
        "    launch an http server to use the editor and the resulting" +
        " photoalbum\n" +
        "add config_file [images...]\n" +
        "    add the given images to the configuration file\n" +
        "cleanup config_file\n" +
        "    remove unused files in the output directory. Use with caution.\n" +
        "render config_file\n" +
        "    render the photoalbum\n" +
        "reset config_file\n" + 
        "    reset a given config_file and delete all images\n"
        );
    process.exit(1);
};

var args = process.argv.splice(2);
if (args.length < 2) {
    usage();
}


switch (args[0]) {
    case "config":
        if (args.length < 3) {
            usage();
        }
        genConfig(args[1], args[2], args[3]);
        break;

    case "editor":
        getJSONFromPath(args[1], function(cfg) {
            setup(cfg, false);
            var onDone = function() {
                setup(cfg, true);
                copyFull(cfg, function() {
                    saveCfg(args[1], cfg);
                    console.log("you can now run '" + process.argv[1] + " server " +
                        args[1] + "' to start a server to edit the album\n");
                });
            };
            genThumbs(cfg, onDone);
        });
        break;

    case "server":
        if (!fs.existsSync("img/")) {
            fs.mkdir("img");
        }

        getJSONFromPath(args[1], function(cfg) {
            //setup(cfg, false);
            server(cfg, args[1]);
        });
        break;

    case "add":
        getJSONFromPath(args[1], function(cfg) {
            addImages(cfg, args[1], args.slice(2));
        });
        break;

    case "cleanup":
        getJSONFromPath(args[1], function(cfg) {
            cleanup(cfg);
        });
        break;

    case "render":
        getJSONFromPath(args[1], function(cfg) {
            setup(cfg, false);
            doRender(cfg, true, function() {
                saveCfg(args[1], cfg);
            });
        });
        break;

    case "reset":
        if (fs.existsSync(args[1])) {

            getJSONFromPath(args[1], function (cfg) {

                if (cfg == void 0 || cfg.out == void 0) return; 

                var newContent = { "images": [], "out": cfg.out, "title": "Pictures", "lang": "en" };
                
                fs.writeFile(args[1], JSON.stringify(newContent), function() {
                    console.log(args[1] + " resetted!");
                })

                fs.writeFile(path.join(cfg.out, "images.json"), "var images = [];" , function() {
                    console.log(path.join(cfg.out, "images.json") + " resetted!");
                })

                clearDir(path.join(cfg.out, "/full")).then(function (numa) {
                    console.log("cleared " + numa + " files in " + path.join(cfg.out, "/full"))
                    clearDir(path.join(cfg.out, "/large")).then(function (numb) {
                        console.log("cleared " + numb + " files in " + path.join(cfg.out, "/large"))
                        clearDir(path.join(cfg.out, "/thumb")).then(function (numc) {
                            console.log("cleared " + numc + " files in " + path.join(cfg.out, "/thumb"))                                 
                        })                    
                    })
                })

            });


        } else {
            console.error(args[1] + " does not exist.");
        }
        
        break;


    default:
        usage();
}

/* }}} */