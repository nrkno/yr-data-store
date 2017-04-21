'use strict';

const agent = require('@yr/agent');
const assign = require('object-assign');
const get = require('./get');

const DEFAULT_LOAD_OPTIONS = {
  cacheControl: 'public, max-age=120, stale-while-revalidate=150, stale-if-error=180',
  rejectOnError: true,
  retry: 2,
  timeout: 5 * 1000
};
const RE_CACHE_CONTROL = /max-age=(\d+)|stale-while-revalidate=(\d+)|stale-if-error=(\d+)/g;

module.exports = fetch;

/**
 * Fetch data. If expired, load from 'url' and store at 'key'
 * @param {DataStore} store
 * @param {String} key
 * @param {String} url
 * @param {Object} options
 *  - {Boolean} abort
 *  - {String} cacheControl
 *  - {Boolean} ignoreQuery
 *  - {Number} retry
 *  - {Boolean} rejectOnError
 *  - {Number} timeout
 * @returns {Promise<Response>}
 */
function fetch(store, key, url, options) {
  options = assign({}, DEFAULT_LOAD_OPTIONS, options);
  options.cacheControl = parseCacheControl(options.cacheControl);

  if (!key) {
    return Promise.resolve({
      body: undefined,
      duration: 0,
      headers: {},
      key,
      status: 400
    });
  }

  return doFetch(store, key, url, options);
}

/**
 * Fetch data. If expired, load from 'url' and store at 'key'
 * @param {DataStore} store
 * @param {String} key
 * @param {String} url
 * @param {Object} options
 *  - {Boolean} abort
 *  - {Object} cacheControl
 *  - {Boolean} ignoreQuery
 *  - {Number} retry
 *  - {Boolean} rejectOnError
 *  - {Number} timeout
 * @returns {Promise}
 */
function doFetch(store, key, url, options) {
  const { cacheControl, rejectOnError } = options;
  const value = get(store, key);
  const isMissing = !value;
  let isExpired = hasExpired(value && value[store.HEADERS_KEY], false);

  store.debug('fetch %s from %s', key, url);

  // Load if missing or expired
  if (isMissing || isExpired) {
    if (!url) {
      return Promise.resolve({
        body: value,
        duration: 0,
        headers: {},
        key,
        status: 400
      });
    }

    return new Promise((resolve, reject) => {
      load(store, key, url, options)
        .then(res => {
          store.debug('fetched %s from %s', key, url);

          const body = get(store, key);

          resolve({
            body,
            duration: res.duration,
            headers: generateResponseHeaders(body[store.HEADERS_KEY], cacheControl),
            key,
            status: res.status
          });
        })
        .catch(err => {
          isExpired = hasExpired(value && value[store.HEADERS_KEY], true);

          if (rejectOnError && isExpired) {
            return reject(err);
          }

          store.debug('fetched stale %s after load error', key);
          return resolve({
            body: isExpired ? undefined : value,
            duration: 0,
            error: err,
            headers: generateResponseHeaders(value && value[store.HEADERS_KEY], cacheControl, true),
            key,
            status: isExpired ? err.status : 200
          });
        });
    });
  }

  store.debug('fetched %s', key);
  return Promise.resolve({
    body: value,
    duration: 0,
    headers: generateResponseHeaders(value && value[store.HEADERS_KEY], cacheControl),
    key,
    status: 200
  });
}

/**
 * Load data from 'url' and store at 'key'
 * @param {DataStore} store
 * @param {String} key
 * @param {String} url
 * @param {Object} options
 *  - {Boolean} abort
 *  - {Boolean} ignoreQuery
 *  - {Number} minExpiry
 *  - {Number} retry
 *  - {Boolean} staleIfError
 *  - {Number} timeout
 * @returns {Promise}
 */
function load(store, key, url, options) {
  const { cacheControl, rejectOnError, retry, timeout } = options;

  options.id = key;

  store.debug('load %s from %s', key, url);

  return agent
    .get(url, options)
    .timeout(timeout)
    .retry(retry)
    .then(res => {
      store.debug('loaded "%s" in %dms', key, res.duration);

      // Guard against empty data
      if (res.body) {
        // Parse cache-control headers
        if (res.headers && 'expires' in res.headers) {
          res.body[store.HEADERS_KEY] = parseLoadHeaders(res.headers, cacheControl);
        }

        // Enable handling by not calling inner set()
        store.set(key, res.body, options);
      }

      return res;
    })
    .catch(err => {
      store.debug('unable to load "%s" from %s', key, url);

      if (rejectOnError) {
        store.set(key, undefined, options);
      }

      throw err;
    });
}

/**
 * Parse 'cacheControlString'
 * @param {String} cacheControlString
 * @returns {Object}
 */
function parseCacheControl(cacheControlString) {
  let maxAge = 0;
  let staleIfError = 0;
  let staleWhileRevalidate = 0;

  if (cacheControlString && typeof cacheControlString === 'string') {
    let match, value;

    while ((match = RE_CACHE_CONTROL.exec(cacheControlString))) {
      if (match[1]) {
        maxAge = staleIfError = staleWhileRevalidate = parseInt(match[1], 10);
      } else if (match[2]) {
        value = parseInt(match[2], 10);
        staleWhileRevalidate = value > maxAge ? value : maxAge;
      } else if (match[3]) {
        value = parseInt(match[3], 10);
        staleIfError = value > maxAge ? value : maxAge;
      }
    }
  }

  return {
    maxAge,
    staleWhileRevalidate,
    staleIfError
  };
}

/**
 * Merge 'cacheControl' with defaults
 * @param {Object} cacheControl
 * @param {Object} defaultCacheControl
 * @returns {Object}
 */
function mergeCacheControl(cacheControl, defaultCacheControl) {
  if (cacheControl == null) {
    return assign({}, defaultCacheControl);
  }

  const maxAge = 'maxAge' in cacheControl ? cacheControl.maxAge : defaultCacheControl.maxAge;
  const staleWhileRevalidate =
    cacheControl.staleWhileRevalidate || defaultCacheControl.staleWhileRevalidate - defaultCacheControl.maxAge;
  const staleIfError = cacheControl.staleIfError || defaultCacheControl.staleIfError - defaultCacheControl.maxAge;

  return {
    maxAge,
    staleWhileRevalidate,
    staleIfError
  };
}

/**
 * Parse 'headers' from load response
 * @param {Object} headers
 * @param {Object} defaultCacheControl
 * @returns {Number}
 */
function parseLoadHeaders(headers, defaultCacheControl) {
  const now = Date.now();
  let expires = now;

  if (headers.expires) {
    expires = typeof headers.expires === 'string' ? Number(new Date(headers.expires)) : headers.expires;
  }

  return {
    cacheControl: mergeCacheControl(parseCacheControl(headers['cache-control']), defaultCacheControl),
    expires: now > expires ? now + defaultCacheControl.maxAge * 1000 : expires
  };
}

/**
 * Generate serialized headers object for response
 * @param {Object} headers
 * @param {Object} defaultCacheControl
 * @param {Boolean} isError
 * @returns {Object}
 */
function generateResponseHeaders(headers = {}, defaultCacheControl, isError) {
  const cacheControl = mergeCacheControl(headers.cacheControl, defaultCacheControl);
  const expires = isError
    ? headers.expires + (cacheControl.staleIfError - cacheControl.maxAge) * 1000
    : headers.expires;
  const now = Date.now();
  // Round up to nearest second
  const maxAge = expires > now ? Math.ceil((expires - now) / 1000) : defaultCacheControl.maxAge;
  let cacheControlString = `public, max-age=${maxAge}`;

  if (cacheControl.staleWhileRevalidate) {
    cacheControlString += `, stale-while-revalidate=${maxAge + cacheControl.staleWhileRevalidate - cacheControl.maxAge}`;
  }
  if (cacheControl.staleIfError) {
    cacheControlString += `, stale-if-error=${maxAge + cacheControl.staleIfError - cacheControl.maxAge}`;
  }

  return {
    'cache-control': cacheControlString,
    expires: new Date(now + maxAge * 1000).toUTCString()
  };
}

/**
 * Check if 'obj' has expired
 * @param {Object} headers
 * @param {Boolean} isError
 * @returns {Boolean}
 */
function hasExpired(headers, isError) {
  if (!headers || !headers.cacheControl) {
    return true;
  }

  const { expires, cacheControl: { maxAge = 0, staleIfError = 0, staleWhileRevalidate = 0 } } = headers;

  return (
    // Round up to nearest second
    Math.ceil(Date.now() / 1000) * 1000 >
    expires + (staleWhileRevalidate - maxAge + (isError ? staleIfError - maxAge : 0)) * 1000
  );
}
