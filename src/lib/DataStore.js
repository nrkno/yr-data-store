'use strict';

const assign = require('object-assign');
const Cursor = require('./DataStoreCursor');
const Debug = require('debug');
const Emitter = require('eventemitter3');
const get = require('./methods/get');
const HandlerContext = require('./HandlerContext');
const isPlainObject = require('is-plain-obj');
const reference = require('./methods/reference');
const set = require('./methods/set');
const update = require('./methods/update');

const HANDLED_METHODS = {
  reset: [reset, ['data']],
  set: [set, ['key', 'value', 'options']]
};
const REF_KEY = '__ref:';

let uid = 0;

module.exports = class DataStore extends Emitter {
  /**
   * Constructor
   * @param {String} [id]
   * @param {Object} [data]
   * @param {Object} [options]
   *  - {Object} handlers
   *  - {Boolean} isWritable
   *  - {Object} serialisableKeys
   */
  constructor (id, data, options = {}) {
    super();

    this.REF_KEY = REF_KEY;

    this.debug = Debug('yr:data' + (id ? ':' + id : ''));
    this.destroyed = false;
    this.id = id || `store${++uid}`;
    this.isWritable = 'isWritable' in options ? options.isWritable : true;

    this._cursors = {};
    this._data = {};
    this._handledMethods = {};
    this._handlers = [];
    this._serialisableKeys = options.serialisableKeys || {};

    this.debug('created');

    // Allow sub classes to send in methods for registration
    const handledMethods = assign({}, HANDLED_METHODS, options.handledMethods || {});

    for (const methodName in handledMethods) {
      this._registerHandledMethod(methodName, ...handledMethods[methodName]);
    }
    if (options.handlers) this.use(options.handlers);

    this.reset(data || {});
  }

  /**
   * Register 'handler' with optional key 'match'
   * Will handle every transaction if no 'match'
   * @param {RegExp|String|Array} [match]
   * @param {Function} handler
   */
  use (match, handler) {
    const matches = !Array.isArray(match)
      ? [[match, handler]]
      : match;

    const handlers = this._handlers.map(({ handler }) => handler);

    matches.forEach(([match, handler]) => {
      if ('function' == typeof match) {
        handler = match;
        match = '';
      }
      if (typeof handler === 'function') {
        this._handlers.push({ handler, match });
      }
    });
  }

  /**
   * Unregister 'handler'
   * @param {RegExp|String|Array} [match]
   * @param {Function} handler
   */
  unuse (match, handler) {
    const matches = !Array.isArray(match)
      ? [[match, handler]]
      : match;

    for (let i = 0, n = matches.length; i < n; i++) {
      let [match, handler] = matches[i];
      let j = this._handlers.length;

      if ('function' == typeof match) handler = match;

      while (--j >= 0) {
        if (this._handlers[j].handler === handler) {
          this._handlers.splice(j, 1);
        }
      }
    }
  }

  /**
   * Retrieve value stored at 'key'
   * Empty 'key' returns all data
   * Array of keys returns array of values
   * @param {String|Array} [key]
   * @returns {*}
   */
  get (key) {
    if (!key || 'string' == typeof key) return get(this, key);
    if (Array.isArray(key)) return key.map((k) => get(this, k));
  }

  /**
   * Store 'value' at 'key'
   * Hash of 'key:value' pairs batches changes
   * @param {String} key
   * @param {*} value
   * @param {Object} [options]
   *  - {Boolean} immutable
   *  - {Boolean} merge
   * @returns {null}
   */
  set (key, value, options) {
    if (!this.isWritable || !key) return;
    if ('string' == typeof key) return this._handledMethods.set(key, value, options);
    if (isPlainObject(key)) {
      for (const k in key) {
        this._handledMethods.set(k, key[k], options);
      }
    }
    if (Array.isArray(key)) {
      for (let i = 0, n = key.length; i < n; i++) {
        this._handledMethods.set(...key[i]);
      }
    }
  }

  /**
   * Store 'value' at 'key', notifying listeners of change
   * Allows passing of arbitrary additional args to listeners
   * Hash of 'key:value' pairs batches changes
   * @param {String|Object} key
   * @param {Object} value
   * @param {Object} [options]
   *  - {Boolean} merge
   */
  update (key, value, options, ...args) {
    if (!this.isWritable || !key) return;
    update(this, key, value, options, ...args);
  }

  /**
   * Retrieve reference to value stored at 'key'
   * Array of keys returns array of references
   * @param {String|Array} [key]
   * @returns {String|Array}
   */
  reference (key) {
    if (!key || 'string' == typeof key) return reference(this, key);
    if (Array.isArray(key)) return key.map((k) => reference(this, k));
  }

  /**
   * Reset underlying 'data'
   * @param {Object} data
   */
  reset (data) {
    this._handledMethods.reset(data);
  }

  /**
   * Destroy instance
   */
  destroy () {
    // Destroy cursors
    for (const key in this._cursors) {
      this._cursors[key].destroy();
    }
    this.destroyed = true;
    this._cursors = {};
    this._data = {};
    this._handlers = [];
    this._serialisableKeys = {};
    this.removeAllListeners();
    this.debug('destroyed');
  }

  /**
   * Retrieve an instance reference at 'key' to a subset of data
   * @param {String} key
   * @returns {DataStore}
   */
  createCursor (key) {
    key = this._resolveRefKey(key || '');
    // Prefix all keys with separator
    if (key && key.charAt(0) != '/') key = `/${key}`;

    let cursor = this._cursors[key];

    // Create and store
    if (!cursor) {
      cursor = new Cursor(key, this);
      this._cursors[key] = cursor;
    }

    return cursor;
  }

  /**
   * Store serialisability of 'key'
   * @param {String|Object} key
   * @param {Boolean} value
   */
  setSerialisabilityOfKey (key, value) {
    // Handle batch
    if (isPlainObject(key)) {
      for (const k in key) {
        this.setSerialisabilityOfKey(k, value);
      }
      return;
    }

    if (key.charAt(0) == '/') key = key.slice(1);

    this._serialisableKeys[key] = value;
  }

  /**
   * Dump all data, optionally stringified
   * @param {Boolean} stringify
   * @returns {Object|String}
   */
  dump (stringify) {
    const data = explode(this, this._data);

    if (stringify) {
      try {
        // Pretty print
        return JSON.stringify(data, null, 2);
      } catch (err) {
        return '';
      }
    }

    return data;
  }

  /**
   * Prepare for serialisation
   * @param {String} [key]
   * @returns {Object}
   */
  toJSON (key) {
    if (key) return serialise(key, get(this, key), this._serialisableKeys);
    return serialise(null, this._data, this._serialisableKeys);
  }

  /**
   * Determine if 'key' matches 'match'
   * @param {String} key
   * @param {RegExp|String} match
   * @returns {Boolean}
   */
  _isMatchKey (key, match) {
    // Treat no match as match all
    if (!match) return true;
    if (match instanceof RegExp) return match.test(key);
    if ('string' == typeof match) return key.indexOf(match) == 0;
    return false;
  }

  /**
   * Determine if 'value' is reference
   * @param {String} value
   * @returns {Boolean}
   */
  _isRefValue (value) {
    if (!value) return false;
    return ('string' == typeof value && value.indexOf(REF_KEY) == 0);
  }

  /**
   * Parse key from 'ref'
   * @param {String} ref
   * @returns {String}
   */
  _parseRefKey (ref) {
    if ('string' != typeof ref) return ref;
    return ref.slice(REF_KEY.length);
  }

  /**
   * Resolve 'key' to nearest __ref key
   * @param {String} key
   * @returns {String}
   */
  _resolveRefKey (key) {
    // Handle passing of __ref key
    if (this._isRefValue(key)) return this._parseRefKey(key);
    // Trim leading '/' (cursors)
    if (key.charAt(0) == '/') key = key.slice(1);

    const segs = key.split('/');
    const n = segs.length;
    let value = this._data;
    let idx = 0;
    let ref = key;

    // Walk data tree from root looking for nearest __ref
    while (idx < n) {
      if (value[segs[idx]] == null) break;
      value = value[segs[idx]];
      if (this._isRefValue(value)) {
        ref = this._parseRefKey(value);
        break;
      }
      idx++;
    }

    // Append relative keys
    if (ref != key && idx < n - 1) {
      ref += `/${segs.slice(idx + 1).join('/')}`;
    }

    return ref;
  }

  /**
   * Register handled method with 'methodName'
   * @param {String} methodName
   * @param {Function} fn
   * @param {Array} signature
   */
  _registerHandledMethod (methodName, fn, signature) {
    if (this._handledMethods[methodName]) return;

    // Partially apply arguments for routing
    this._handledMethods[methodName] = this._routeHandledMethod.bind(this, methodName, fn, signature);
    // Expose method if it doesn't exist
    if (!this[methodName]) this[methodName] = this._handledMethods[methodName];
  }

  /**
   * Route 'fn' through handlers
   * @param {String} methodName
   * @param {Function} fn
   * @param {Array} signature
   * @param {*} args
   * @returns {Object|null}
   */
  _routeHandledMethod (methodName, fn, signature, ...args) {
    const isKeyed = signature[0] == 'key';
    let [key = '', ...rest] = args;

    if (isKeyed && key && key.charAt(0) == '/') key = key.slice(1);

    // Defer to handlers
    if (this._handlers.length) {
      const context = new HandlerContext(this, methodName, signature, args);

      for (let i = 0, n = this._handlers.length; i < n; i++) {
        if (this._isMatchKey(key, this._handlers[i].match)) this._handlers[i].handler(context);
      }

      const value = fn(this, ...context.toArguments());

      context.destroy();
      return value;
    }

    return fn(this, key, ...rest);
  }
};

/**
 * Reset underlying 'data'
 * @param {DataStore} store
 * @param {Object} data
 */
function reset (store, data) {
  store.debug('reset');
  store._data = data;
}

/**
 * Retrieve serialisable 'data'
 * @param {String} key
 * @param {Object} data
 * @param {Object} config
 * @returns {Object}
 */
function serialise (key, data, config) {
  if (isPlainObject(data)) {
    let obj = {};

    for (const prop in data) {
      const keyChain = key
        ? `${key}/${prop}`
        : prop;
      const value = data[prop];

      if (config[keyChain] !== false) {
        if (isPlainObject(value)) {
          obj[prop] = serialise(keyChain, value, config);
        } else if (value !== null && 'object' == typeof value && 'toJSON' in value) {
          obj[prop] = value.toJSON();
        } else {
          obj[prop] = value;
        }
      }
    }

    return obj;
  }

  return (config[key] !== false)
    ? data
    : null;
}

/**
 * Resolve all nested references for 'data'
 * @param {DataStore} store
 * @param {Object} data
 * @returns {Object}
 */
function explode (store, data) {
  if (isPlainObject(data)) {
    let obj = {};

    for (const prop in data) {
      obj[prop] = explode(store, data[prop]);
    }
    return obj;
  } else if (Array.isArray(data)) {
    return data.map((value) => explode(store, value));
  } else if (store._isRefValue(data)) {
    return explode(store, store.get(store._parseRefKey(data)));
  }

  return data;
}