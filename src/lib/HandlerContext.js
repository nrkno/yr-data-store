'use strict';

const assign = require('object-assign');

module.exports = class HandlerContext {
  /**
   * Constructor
   * @param {DataStore} store
   * @param {Array} signature
   * @param {Array} args
   */
  constructor (store, signature, args) {
    this.signature = signature;
    this.store = store;

    // Use signature to copy relevant arguments to this instance
    for (let i = 0, n = signature.length; i < n; i++) {
      let prop = signature[i];

      if (prop.indexOf('...') == 0) {
        prop = prop.slice(3);
        this[prop] = args.slice(i);
      } else {
        this[prop] = args[i];
      }
    }
  }

  /**
   * Batch 'key' with existing
   * @param {String|Object} key
   * @param {*} [value]
   */
  batchKey (key, value) {
    if (!this.key) this.key = '';

    const asArray = (value === undefined);
    const isString = ('string' == typeof key);

    // Convert existing to hash/array
    if ('string' == typeof this.key) {
      this.key = asArray
        ? [this.key]
        : { [this.key]: this.value };
      if ('value' in this) this.value = null;
    }

    if (asArray) {
      if (isString) {
        this.key.push(key);
      } else {
        this.key.push(...key);
      }
      return;
    }

    if (isString) {
      this.key[key] = value;
    } else {
      this.key = assign(this.key, key);
    }
  }

  /**
   * Merge 'options' with existing
   * @param {Object} options
   */
  mergeOptions (options) {
    this.options = assign({}, options, this.options);
  }

  /**
   * Convert instance to arguments
   * @returns {Array}
   */
  toArguments () {
    let args = [];

    for (let i = 0, n = this.signature.length; i < n; i++) {
      let prop = this.signature[i];

      if (prop.indexOf('...') == 0) {
        prop = prop.slice(3);
        args.push(...this[prop]);
      } else {
        args.push(this[prop]);
      }
    }

    return args;
  }

  /**
   * Destroy
   */
  destroy () {
    for (const prop in this) {
      this[prop] = null;
    }
  }
};