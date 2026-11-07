'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { textToFrames } = require('../src/display');
const { Htpasswd } = require('../src/htpasswd');

test('short text is one centred static frame', () => {
  const { text, frames } = textToFrames('Hi');
  assert.strictEqual(text, 'HI');
  assert.strictEqual(frames.length, 1);
  assert.strictEqual(frames[0].length, 7);
  assert.strictEqual(frames[0][0], 0);
  assert.strictEqual(frames[0][6], 0);
  // Every row fits the 26-column display.
  for (const row of frames[0].slice(1, 6)) assert.ok(row >= 0 && row < 2 ** 26);
});

test('long text scrolls, stays within 140 frames, accents are folded', () => {
  const { text, frames } = textToFrames('Bon appétit Minou !');
  assert.strictEqual(text, 'BON APPETIT MINOU');
  assert.ok(frames.length > 1 && frames.length <= 140);
  for (const f of frames) for (const row of f.slice(1, 6)) assert.ok(row >= 0 && row < 2 ** 26);
});

test('htpasswd accepts bcrypt ($2y$ too) and {SHA}, refuses the rest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'htp-'));
  const file = path.join(dir, 'htpasswd');
  const y = bcrypt.hashSync('s3cret', 4).replace(/^\$2b\$/, '$2y$');
  const sha = `{SHA}${crypto.createHash('sha1').update('other').digest('base64')}`;
  fs.writeFileSync(file, `# comment\nhomey:${y}\nmqtt:${sha}\nold:$apr1$abc$def\n`);
  const h = new Htpasswd(file);
  assert.strictEqual(h.verify('homey', 's3cret'), true);
  assert.strictEqual(h.verify('homey', 'wrong'), false);
  assert.strictEqual(h.verify('mqtt', 'other'), true);
  assert.strictEqual(h.verify('old', 'x'), false);
  assert.strictEqual(h.verify('nobody', 'x'), false);
  const header = `Basic ${Buffer.from('homey:s3cret').toString('base64')}`;
  assert.strictEqual(h.checkHeader(header), 'homey');
  assert.strictEqual(h.checkHeader('Bearer x'), null);
});
