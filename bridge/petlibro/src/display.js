'use strict';

// Text -> frames for the One RFID's LED matrix (DISPLAY_MATRIX_SERVICE).
//
// Ported from petlibro-local's display_matrix.py (MIT, smcneece/petlibro-local),
// whose encoding was decoded from captures of the Petlibro app:
// - 5 rows per frame, each row an integer bitmask, bit 0 = rightmost column;
// - a frame is sent as [0, r1, r2, r3, r4, r5, 0];
// - the display is 26 columns wide;
// - text that fits is one centred static frame, longer text scrolls in from
//   the right, one column per frame, and loops.

const DISPLAY_WIDTH = 26;
const CHAR_WIDTH = 3;
const LOOP_GAP = 4;
// More than 140 frames spills into the feeder's pet-name storage (petlibro-local).
const MAX_FRAMES = 140;
const MAX_TEXT = 20;

// 3x5 font, bit 0 = leftmost pixel of the glyph.
const FONT = {
  ' ': [0, 0, 0, 0, 0],
  A: [2, 5, 7, 5, 5], B: [3, 5, 3, 5, 3], C: [6, 1, 1, 1, 6], D: [3, 5, 5, 5, 3],
  E: [7, 1, 3, 1, 7], F: [7, 1, 3, 1, 1], G: [6, 1, 5, 5, 6], H: [5, 5, 7, 5, 5],
  I: [7, 2, 2, 2, 7], J: [4, 4, 4, 5, 2], K: [5, 3, 1, 3, 5], L: [1, 1, 1, 1, 7],
  M: [5, 7, 5, 5, 5], N: [5, 7, 7, 5, 5], O: [2, 5, 5, 5, 2], P: [3, 5, 3, 1, 1],
  Q: [2, 5, 5, 3, 6], R: [3, 5, 3, 5, 5], S: [6, 1, 2, 4, 3], T: [7, 2, 2, 2, 2],
  U: [5, 5, 5, 5, 2], V: [5, 5, 5, 2, 2], W: [5, 5, 7, 5, 5], X: [5, 5, 2, 5, 5],
  Y: [5, 5, 2, 2, 2], Z: [7, 4, 2, 1, 7],
  0: [2, 5, 5, 5, 2], 1: [2, 3, 2, 2, 7], 2: [3, 4, 6, 1, 7], 3: [3, 4, 6, 4, 3],
  4: [5, 5, 7, 4, 4], 5: [7, 1, 3, 4, 3], 6: [2, 1, 3, 5, 2], 7: [7, 4, 2, 2, 2],
  8: [2, 5, 2, 5, 2], 9: [2, 5, 6, 4, 2],
};

// Accents folded to their base letter (a French name is the likely input),
// anything the font cannot draw becomes a space.
function normalise(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .split('')
    .map((ch) => (FONT[ch] ? ch : ' '))
    .join('')
    .slice(0, MAX_TEXT);
}

function buildStrips(text) {
  const strips = [[], [], [], [], []];
  for (const ch of text) {
    const glyph = FONT[ch] || FONT[' '];
    for (let r = 0; r < 5; r += 1) {
      for (let col = 0; col < CHAR_WIDTH; col += 1) strips[r].push((glyph[r] >> col) & 1);
      strips[r].push(0);
    }
  }
  for (let r = 0; r < 5; r += 1) for (let i = 0; i < LOOP_GAP; i += 1) strips[r].push(0);
  return strips;
}

function framesFor(text) {
  if (!text) return [];
  const charPixels = text.length * (CHAR_WIDTH + 1);
  const strips = buildStrips(text);
  const n = strips[0].length;

  if (charPixels <= DISPLAY_WIDTH) {
    const margin = Math.floor((DISPLAY_WIDTH - charPixels) / 2);
    const rows = [];
    for (let r = 0; r < 5; r += 1) {
      let val = 0;
      for (let col = 0; col < charPixels; col += 1) {
        const pos = (n - LOOP_GAP - 1) - col;
        if (pos >= 0 && pos < n) val |= strips[r][pos] << col;
      }
      rows.push(val * 2 ** margin);
    }
    return [[0, ...rows, 0]];
  }

  const frames = [];
  for (let i = 0; i < n; i += 1) {
    const rows = [];
    for (let r = 0; r < 5; r += 1) {
      let val = 0;
      for (let col = 0; col < DISPLAY_WIDTH; col += 1) {
        const pos = (((i - col) % n) + n) % n;
        val |= strips[r][pos] << col;
      }
      rows.push(val >>> 0);
    }
    frames.push([0, ...rows, 0]);
  }
  return frames;
}

// The frames for a message, shortened until it fits the feeder's frame budget.
function textToFrames(input) {
  let text = normalise(input).trimEnd();
  let frames = framesFor(text);
  while (frames.length > MAX_FRAMES && text.length > 1) {
    text = text.slice(0, -1).trimEnd();
    frames = framesFor(text);
  }
  return { text, frames };
}

module.exports = { textToFrames, normalise, MAX_TEXT };
