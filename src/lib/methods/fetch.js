'use strict';

const agent = require('@yr/agent');
const assign = require('object-assign');
const get = require('./get');
const isPlainObject = require('is-plain-obj');

const DEFAULT_LOAD_OPTIONS = {
  minExpiry: 60000,
  retry: 2,
  timeout: 5000
};

module.exports = fetch;
module.exports.all = fetchAll;

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
    return Promise.resolve({
      body: undefined,
      duration: 0,
      headers: { status: 500 },
      key
    });
  }

  options = assign({}, DEFAULT_LOAD_OPTIONS, options);

  return doFetch(store, key, url, options);
}

/**
 * Batch version of 'fetch()'
 * Accepts an array of tuples [[key: String, url: String, options: Object]]
 * @param {DataStore} store
 * @param {Array<Array>} keys
 * @param {Object} [options]
 *  - {Boolean} abort
 *  - {Boolean} ignoreQuery
 *  - {Number} minExpiry
 *  - {Number} retry
 *  - {Boolean} staleWhileRevalidate
 *  - {Boolean} staleIfError
 *  - {Number} timeout
 * @returns {Promise<Array>}
 */
function fetchAll(store, keys, options) {
  if (Array.isArray(keys)) {
    return Promise.all(
      keys.map(args => {
        const [key, url, opts = {}] = args;

        return fetch(store, key, url, assign({}, options, opts));
      })
    );
  }

  return Promise.resolve([]);
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
  const isMissingOrExpired = !value || hasExpired(value, store.EXPIRES_KEY);

  // Load if missing or expired
  if (isMissingOrExpired) {
    if (!url) {
      return Promise.resolve({
        body: value,
        duration: 0,
        headers: { status: 500 },
        key
      });
    }

    store.debug('fetch %s from %s', key, url);

    const promiseToLoad = new Promise((resolve, reject) => {
      load(store, key, url, options)
        .then(res => {
          resolve({
            body: get(store, key),
            duration: res.duration,
            headers: res.headers,
            key
          });
        })
        .catch(err => {
          if (!staleIfError) {
            return reject(err);
          }
          resolve({
            body: value,
            duration: 0,
            error: err,
            headers: { expires: new Date(Date.now() + minExpiry).toUTCString(), status: err.status },
            key
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

  // Return data (possibly stale)
  return Promise.resolve({
    body: value,
    duration: 0,
    headers: { status: 200 },
    key
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
        let data = res.body;

        // Add expires header
        if (res.headers && 'expires' in res.headers) {
          data[store.EXPIRES_KEY] = getExpiry(res.headers.expires, minExpiry, store.GRACE);
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
 * Retrieve expiry from 'dateString'
 * @param {Number} dateString
 * @param {Number} minimum
 * @param {Number} grace
 * @returns {Number}
 */
function getExpiry(dateString, minimum, grace) {
  // Add latency overhead to compensate for transmission time
  const expires = Number(new Date(dateString)) + grace;
  const now = Date.now();

  return expires > now
    ? expires
    : // Local clock is set incorrectly
      now + minimum;
}

/**
 * Check if 'obj' has expired
 * @param {Object} obj
 * @param {String} expiresKey
 * @returns {Boolean}
 */
function hasExpired(obj, expiresKey) {
  return obj && isPlainObject(obj) && expiresKey in obj && Date.now() > obj[expiresKey];
}
