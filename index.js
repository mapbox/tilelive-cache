var util = require('util');

module.exports = function(options, Source) {
    if (!Source) throw new Error('No source provided');
    if (!Source.prototype.get) throw new Error('No get method found on source');

    function Caching() { return Source.apply(this, arguments); }

    // Inheritance.
    util.inherits(Caching, Source);

    // References for testing, convenience, post-call overriding.
    Caching.options = options;

    Caching.prototype.get = module.exports.cachingGet('TL4', options, Source.prototype.get);

    return Caching;
};

module.exports.cachingGet = function(namespace, options, get) {
    if (!get) throw new Error('No get function provided');
    if (!namespace) throw new Error('No namespace provided');

    options = options || {};
    options.stale = typeof options.stale === 'number' ? options.stale : 300;
    options.ttl = typeof options.ttl === 'number' ? options.ttl : 300;

    if (!options.client) throw new Error('No cache client');
    if (!options.stale) throw new Error('No stale option set');
    if (!options.ttl) throw new Error('No ttl option set');

    return function(url, callback) {
        var key = namespace + '-' + url;
        var source = this;
        var client = options.client;
        var stale = options.stale;
        var ttl = options.ttl;

        client.get(key, function(err, encoded) {
            // If error on get, pass through to original source
            // without attempting a set after retrieval.
            if (err) {
                err.key = key;
                client.error(err);
                return get.call(source,url, callback);
            }

            // Cache hit.
            var data;
            if (encoded) try {
                data = decode(encoded);
            } catch(e) {
                e.key = key;
                client.error(e);
            }
            if (data) {
                callback(data.err, data.buffer, data.headers);
                if (isFresh(data)) return;

                // Update cache & bump `expires` header
                get.call(source, url, function(err, buffer, headers) {
                    if (err && !errcode(err)) return client.emit('error', err);

                    headers = headers || {};
                    headers = setEx(key, err, buffer, headers, ttl, stale);
                });
            } else {
                // Cache miss, error, or otherwise no data
                get.call(source, url, function(err, buffer, headers) {
                    if (err && !errcode(err)) return callback(err);

                    headers = headers || {};
                    headers = setEx(key, err, buffer, headers, ttl, stale);
                    callback(err, buffer, headers);
                });
            }
        });

        function setEx(key, err, buffer, headers, ttl, stale) {
            var expires = headers.Expires || headers.expires;
            delete headers.Expires;
            delete headers.expires;
            if (expires) {
                headers.expires = expires;
                headers['x-tl-expires'] = expires;
            } else {
                headers['x-tl-expires'] = (new Date(Date.now() + (ttl * 1000))).toUTCString();
            }

            // seconds from now to expiration time
            var sec = Math.ceil((Number(new Date(headers['x-tl-expires'])) - Number(new Date()))/1000);

            // stale is the number of extra seconds to cache an object
            // past its expires time where we may serve a "stale"
            // version of the object.
            //
            // When an upstream expires is set no stale padding is used
            // so that the upstream expires is fully respected.
            var pad = expires ? 0 : stale;

            if (sec > 0) client.set(key, sec + pad, encode(err, buffer, headers), function(err) {
                if (!err) return;
                err.key = key;
                client.error(err);
            });

            return headers;
        }

        function isFresh(d) {
            // When we don't have an expires header just assume staleness
            if (d.headers === undefined || !d.headers['x-tl-expires']) return false;

            return (+(new Date(d.headers['x-tl-expires'])) > Date.now());
        }
    };
};

module.exports.encode = encode;
module.exports.decode = decode;

function errcode(err) {
    if (!err) return;
    if (err.statusCode === 404) return 404;
    if (err.statusCode === 403) return 403;
    return;
}

function encode(err, buffer, headers) {
    if (errcode(err)) return errcode(err).toString();

    // Unhandled error.
    if (err) return null;

    headers = headers || {};

    // Turn objects into JSON string buffers.
    if (buffer && typeof buffer === 'object' && !(buffer instanceof Buffer)) {
        headers['x-tl-json'] = true;
        buffer = new Buffer(JSON.stringify(buffer));
    // Turn strings into buffers.
    } else if (buffer && !(buffer instanceof Buffer)) {
        buffer = new Buffer(buffer);
    }

    headers = new Buffer(JSON.stringify(headers), 'utf8');

    if (headers.length > 1024) {
        throw new Error('Invalid cache value - headers exceed 1024 bytes: ' + JSON.stringify(headers));
    }

    var padding = new Buffer(1024 - headers.length);
    padding.fill(' ');
    var len = headers.length + padding.length + buffer.length;
    return Buffer.concat([headers, padding, buffer], len);
}

function decode(encoded) {
    if (encoded.length == 3) {
        encoded = encoded.toString();
        if (encoded === '404' || encoded === '403') {
            var err = new Error();
            err.statusCode = parseInt(encoded, 10);
            err.tlcache= true;
            return { err: err };
        }
    }

    // First 1024 bytes reserved for header + padding.
    var offset = 1024;
    var data = {};
    data.headers = encoded.slice(0, offset).toString().trim();

    try {
        data.headers = JSON.parse(data.headers);
    } catch(e) {
        throw new Error('Invalid cache value');
    }

    data.headers['x-tl-cache'] = 'hit';
    data.buffer = encoded.slice(offset);

    // Return JSON-encoded objects to true form.
    if (data.headers['x-tl-json']) data.buffer = JSON.parse(data.buffer);

    if (data.headers['content-length'] && data.headers['content-length'] != data.buffer.length)
        throw new Error('Content length does not match');
    return data;
}
