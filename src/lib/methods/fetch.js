'use strict';

const agent = require('@yr/agent');
const assign = require('object-assign');
const get = require('./get');
const isPlainObject = require('is-plain-obj');

const DEFAULT_LOAD_OPTIONS = {
  // 2 min
  minExpiry: 2 * 60 * 1000,
  retry: 2,
  // 5 sec
  timeout: 5 * 1000
};

module.exports = fetch;

/**
 * Fetch data. If expired, load from 'url' and store at 'key'
 * @param {DataStore} store
 * @param {String} key
 * @param {String} url
 * @param {Object} options
 *  - {Boolean} abort
 *  - {Boolean} ignoreQuery
 *  - {Number} minExpiry
 *  - {Number} retry
 *  - {Boolean} staleWhileRevalidate
 *  - {Boolean} staleIfError
 *  - {Number} timeout
 * @returns {Promise<Response>}
 */
function fetch(store, key, url, options) {
  if (!key) {
    return Promise.reject(new Error('missing fetch key'));
  }

  options = assign({}, DEFAULT_LOAD_OPTIONS, options);

  return doFetch(store, key, url, options);
}

/**
 * Fetch data. If expired, load from 'url' and store at 'key'
 * @param {DataStore} store
 * @param {String} key
 * @param {String} url
 * @param {Object} options
 *  - {Boolean} abort
 *  - {Boolean} ignoreQuery
 *  - {Number} minExpiry
 *  - {Number} retry
 *  - {Boolean} staleWhileRevalidate
 *  - {Boolean} staleIfError
 *  - {Number} timeout
 * @returns {Promise}
 */
function doFetch(store, key, url, options) {
  const { minExpiry, staleWhileRevalidate, staleIfError } = options;
  const value = get(store, key);
  const isExpired = hasExpired(value, store.EXPIRES_KEY);
  const isMissing = !value;

  store.debug('fetch %s from %s', key, url);

  // Load if missing or expired
  if (isMissing || isExpired) {
    if (!url) {
      return Promise.reject(new Error('missing fetch url'));
    }

    const promiseToLoad = new Promise((resolve, reject) => {
      load(store, key, url, options)
        .then(res => {
          store.debug('fetched %s from %s', key, url);
          resolve({
            body: get(store, key),
            duration: res.duration,
            headers: res.headers,
            key,
            status: res.status
          });
        })
        .catch(err => {
          if (!staleIfError) {
            return reject(err);
          }
          store.debug('fetched stale %s after load error', key);
          return resolve({
            body: value,
            duration: 0,
            error: err,
            headers: getHeaders(0, minExpiry),
            key,
            status: err.status
          });
        });
    });

    if (!(value && staleWhileRevalidate)) {
      return promiseToLoad;
    }
    // Prevent unhandled
    promiseToLoad.catch(err => {
      /* promise never returned, so swallow error */
    });
  }

  store.debug('fetched %s %s', isMissing ? 'new' : isExpired ? 'stale' : 'existing', key);
  // Return data (possibly stale)
  return Promise.resolve({
    body: value,
    duration: 0,
    // Short expiry while revalidating
    headers: getHeaders(value && value[store.EXPIRES_KEY], staleWhileRevalidate ? store.GRACE * 4 : minExpiry),
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
  const { minExpiry, retry, staleIfError, timeout } = options;

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
        const data = res.body;

        // Add expires header
        if (res.headers && 'expires' in res.headers) {
          data[store.EXPIRES_KEY] = getExpires(res.headers.expires, minExpiry, store.GRACE);
        }

        // Enable handling by not calling inner set()
        store.set(key, data, options);
      }

      return res;
    })
    .catch(err => {
      store.debug('unable to load "%s" from %s', key, url);

      if (!staleIfError) {
        store.set(key, undefined, options);
      }

      throw err;
    });
}

/**
 * Retrieve expires from 'dateString'
 * @param {Number} dateString
 * @param {Number} minExpiry
 * @param {Number} grace
 * @returns {Number}
 */
function getExpires(dateString, minExpiry, grace) {
  // Add latency overhead to compensate for transmission time
  const expires = Number(new Date(dateString)) + grace;
  const now = Date.now();

  return expires > now ? expires : now + minExpiry;
}

/**
 * Retrieve headers object
 * @param {Number} [expires]
 * @param {Number} minExpiry
 * @returns {Object}
 */
function getHeaders(expires, minExpiry) {
  const now = Date.now();

  if (!expires || expires < now) {
    expires = now + minExpiry;
  }

  return {
    'cache-control': `public, max-age=${Math.ceil((expires - now) / 1000)}`,
    expires: new Date(expires).toUTCString()
  };
}

/**
 * Check if 'obj' has expired
 * @param {Object} obj
 * @param {String} expiresKey
 * @returns {Boolean}
 */
function hasExpired(obj, expiresKey) {
  return !!(obj && isPlainObject(obj) && expiresKey in obj && Date.now() > obj[expiresKey]);
}
