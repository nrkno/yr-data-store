'use strict';

const assign = require('object-assign');
const isPlainObject = require('is-plain-obj');
const property = require('@yr/property');
const runtime = require('@yr/runtime');

const DEFAULT_OPTIONS = {
  // Browser immutable by default
  immutable: runtime.isBrowser,
  merge: true
};

/**
 * Store 'value' at 'key'
 * Hash of 'key:value' pairs batches changes
 * @param {DataStore} store
 * @param {String|Object} key
 * @param {*} value
 * @param {Object} [options]
 *  - {Boolean} immutable
 *  - {Boolean} merge
 * @returns {null}
 */
module.exports = function set(store, key, value, options) {
  if (!key) {
    return;
  }

  options = assign({}, DEFAULT_OPTIONS, options);

  if (typeof key === 'string') {
    return doSet(store, key, value, options);
  }
  if (isPlainObject(key)) {
    for (const k in key) {
      doSet(store, k, key[k], options);
    }
  }
  if (Array.isArray(key)) {
    for (let i = 0, n = key.length; i < n; i++) {
      const [k, v, o = {}] = key[i];

      doSet(store, k, v, assign({}, DEFAULT_OPTIONS, o));
    }
  }
};

/**
 * Store 'value' at 'key'
 * @param {DataStore} store
 * @param {String} key
 * @param {*} value
 * @param {Object} [options]
 *  - {Boolean} immutable
 *  - {Boolean} merge
 */
function doSet(store, key, value, options) {
  // Resolve back to original key if referenced
  key = store._resolveRefKey(key);

  if (options.immutable) {
    // Returns same if no change
    const newData = property.set(store._data, key, value, options);

    if (newData !== store._data) {
      store._data = newData;
    } else {
      store.debug('WARNING no change after set "%s', key);
    }
    return;
  }

  property.set(store._data, key, value, options);
}
