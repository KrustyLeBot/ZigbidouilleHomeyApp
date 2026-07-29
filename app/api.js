'use strict';

// Endpoints backing the settings page, so recent errors can be inspected from
// Homey without the CLI.

const errlog = require('./lib/errlog');

module.exports = {
  async getErrors() {
    return { entries: errlog.list() };
  },

  async clearErrors() {
    errlog.clear();
    return { ok: true };
  },
};
