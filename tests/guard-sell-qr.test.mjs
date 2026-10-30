import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from './helpers/vm-realm.mjs';

/* GUARD-SELL: the QR encoder inside crew/guard-sell.js (no outside QR service, no library). Checked against values from
   ISO/IEC 18004 (data capacities, format and version information) and the worked Reed-Solomon example "HELLO WORLD"
   1-M, then read back by an independent reader written here (its own function-pattern map, zigzag, de-interleaving and
   byte-mode parser) for the sizes the sales tool uses. */

const source = readFileSync(new URL('../crew/guard-sell.js', import.meta.url), 'utf8');
const realm = vm.createContext({ TextEncoder, TextDecoder });
vm.runInContext(source, realm);
const { qrMatrix, _test: qr } = realm.EGCGuardSell;

// Data codewords per version (1-20) for L, M, Q, H (ISO/IEC 18004 table 7).
const CAPACITY = {
  L: [19, 34, 55, 80, 108, 136, 156, 194, 232, 274, 324, 370, 428, 461, 523, 589, 647, 721, 795, 861],
  M: [16, 28, 44, 64, 86, 108, 124, 154, 182, 216, 254, 290, 334, 365, 415, 453, 507, 563, 627, 669],
  Q: [13, 22, 34, 48, 62, 76, 88, 110, 132, 154, 180, 206, 244, 261, 295, 325, 367, 397, 445, 485],
  H: [9, 16, 26, 36, 46, 60, 66, 86, 100, 122, 140, 158, 180, 197, 223, 253, 283, 313, 341, 385],
};
// The 15-bit format information for each level and mask 0-7 (ISO/IEC 18004 annex C, after the 101010000010010 mask).
const FORMAT = {
  L: ['111011111000100', '111001011110011', '111110110101010', '111100010011101', '110011000101111', '110001100011000', '110110001000001', '110100101110110'],
  M: ['101010000010010', '101000100100101', '101111001111100', '101101101001011', '100010111111001', '100000011001110', '100111110010111', '100101010100000'],
  Q: ['011010101011111', '011000001101000', '011111100110001', '011101000000110', '010010010110100', '010000110000011', '010111011011010', '010101111101101'],
  H: ['001011010001001', '001001110111110', '001110011100111', '001100111010000', '000011101100010', '000001001010101', '000110100001100', '000100000111011'],
};
// Version information for versions 7-20 (annex D).
const VERSION_INFO = { 7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3, 11: 0x0bbf6, 12: 0x0c762, 13: 0x0d847, 14: 0x0e60d, 15: 0x0f928, 16: 0x10b78, 17: 0x1145d, 18: 0x12a17, 19: 0x13532, 20: 0x149a6 };
// Alignment centres and error-correction structure (blocks, ecc codewords per block) for the versions read back below.
const LAYOUT = { 1: { align: [], M: [1, 10], L: [1, 7] }, 3: { align: [6, 22], M: [1, 26], H: [2, 22] }, 8: { align: [6, 24, 42], M: [4, 22] }, 15: { align: [6, 26, 48, 70], M: [10, 24], Q: [12, 30] } };

const formatBits = (modules, size) => {
  // Copy 1 around the top-left finder and copy 2 split over the other two finders, bit 0 first (as placed).
  const one = [], two = [];
  for (let i = 0; i <= 5; i++) one.push(modules[i][8]);
  one.push(modules[7][8], modules[8][8], modules[8][7]);
  for (let i = 9; i < 15; i++) one.push(modules[8][14 - i]);
  for (let i = 0; i < 8; i++) two.push(modules[8][size - 1 - i]);
  for (let i = 8; i < 15; i++) two.push(modules[size - 15 + i][8]);
  const value = bits => bits.reduce((acc, dark, i) => acc | (dark ? 1 << i : 0), 0);
  return [value(one), value(two)];
};

// An independent reader: rebuilds the function-pattern map, unmasks, reads the zigzag, de-interleaves and parses byte mode.
function readBack(matrix, level) {
  const { modules, size, version } = matrix, layout = LAYOUT[version], fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (x0, y0, w, h) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (x >= 0 && y >= 0 && x < size && y < size) fn[y][x] = true; };
  mark(0, 0, 9, 9); mark(size - 8, 0, 8, 9); mark(0, size - 8, 9, 8);
  mark(6, 0, 1, size); mark(0, 6, size, 1);
  const last = layout.align.length - 1;
  layout.align.forEach((cx, i) => layout.align.forEach((cy, j) => { if (!(i === 0 && j === 0 || i === 0 && j === last || i === last && j === 0)) mark(cx - 2, cy - 2, 5, 5); }));
  if (version >= 7) { mark(size - 11, 0, 3, 6); mark(0, size - 11, 6, 3); }
  const [format] = formatBits(modules, size), formatText = format.toString(2).padStart(15, '0');
  const mask = FORMAT[level].indexOf(formatText);
  assert.ok(mask >= 0, `format information ${formatText} is a valid ${level} pattern`);
  const masks = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0, (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => x * y % 2 + x * y % 3 === 0, (x, y) => (x * y % 2 + x * y % 3) % 2 === 0, (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0];
  const bits = [];
  for (let right = size - 1, upward = true; right >= 1; right -= 2, upward = !upward) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const y = upward ? size - 1 - step : step;
      for (const x of [right, right - 1]) if (!fn[y][x]) bits.push(modules[y][x] !== masks[mask](x, y) ? 1 : 0);
    }
  }
  const [blocks, ecc] = layout[level], total = CAPACITY[level][version - 1] + blocks * ecc;
  const codewords = []; for (let i = 0; i + 8 <= bits.length && codewords.length < total; i += 8) codewords.push(bits.slice(i, i + 8).reduce((acc, bit) => acc << 1 | bit, 0));
  assert.equal(codewords.length, total);
  const dataTotal = CAPACITY[level][version - 1], shortData = Math.floor(dataTotal / blocks), longBlocks = dataTotal % blocks;
  const lengths = Array.from({ length: blocks }, (_, i) => shortData + (i >= blocks - longBlocks ? 1 : 0));
  const split = lengths.map(() => ({ data: [], ecc: [] }));
  let at = 0;
  for (let i = 0; i < shortData + 1; i++) split.forEach((block, b) => { if (i < lengths[b]) block.data.push(codewords[at++]); });
  for (let i = 0; i < ecc; i++) split.forEach(block => block.ecc.push(codewords[at++]));
  const divisor = qr.rsDivisor(ecc);
  for (const block of split) assert.deepEqual([...qr.rsRemainder(block.data, divisor)], block.ecc, 'every block\'s error correction checks out');
  const data = split.flatMap(block => block.data), stream = data.flatMap(byte => [7, 6, 5, 4, 3, 2, 1, 0].map(shift => (byte >> shift) & 1));
  const take = n => { const value = stream.slice(0, n).reduce((acc, bit) => acc * 2 + bit, 0); stream.splice(0, n); return value; };
  assert.equal(take(4), 0b0100, 'byte mode');
  const length = take(version < 10 ? 8 : 16), bytes = Array.from({ length }, () => take(8));
  return { text: new TextDecoder().decode(new Uint8Array(bytes)), mask };
}

test('Reed-Solomon matches the standard HELLO WORLD 1-M example and the capacities match the standard', () => {
  assert.deepEqual([...qr.rsRemainder([32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17], qr.rsDivisor(10))], [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  for (const level of ['L', 'M', 'Q', 'H']) assert.deepEqual(Array.from({ length: 20 }, (_, i) => qr.dataCodewords(i + 1, level)), CAPACITY[level], level);
  assert.deepEqual([...qr.alignmentPositions(1)], []); assert.deepEqual([...qr.alignmentPositions(8)], [6, 24, 42]); assert.deepEqual([...qr.alignmentPositions(15)], [6, 26, 48, 70]); assert.deepEqual([...qr.alignmentPositions(20)], [6, 34, 62, 90]);
});

test('format and version information are the standard bits in both copies, for every level and mask', () => {
  for (const level of ['L', 'M', 'Q', 'H']) for (let mask = 0; mask < 8; mask++) {
    const matrix = qrMatrix('GUARD', { level, mask }), [one, two] = formatBits(matrix.modules, matrix.size);
    assert.equal(matrix.mask, mask);
    assert.equal(one.toString(2).padStart(15, '0'), FORMAT[level][mask], `${level} mask ${mask}`);
    assert.equal(two, one, 'both copies agree');
    assert.equal(matrix.modules[matrix.size - 8][8], true, 'the dark module');
  }
  for (let version = 7; version <= 20; version++) {
    const text = 'x'.repeat(CAPACITY.L[version - 2]), matrix = qrMatrix(text, { level: 'L' });
    assert.equal(matrix.version, version);
    const size = matrix.size, read = (getter) => Array.from({ length: 18 }, (_, i) => getter(size - 11 + i % 3, Math.floor(i / 3))).reduce((acc, dark, i) => acc | (dark ? 1 << i : 0), 0);
    assert.equal(read((a, b) => matrix.modules[b][a]), VERSION_INFO[version], `version ${version} top right`);
    assert.equal(read((a, b) => matrix.modules[a][b]), VERSION_INFO[version], `version ${version} bottom left`);
  }
});

test('finder and timing patterns are where a phone camera looks for them', () => {
  const matrix = qrMatrix('https://easygaragecleaning.com/api/garage-guard-link?s=cs_test_synthetic&k=x'), { modules, size } = matrix;
  const finder = (cx, cy) => { for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) assert.equal(modules[cy + dy][cx + dx], Math.max(Math.abs(dx), Math.abs(dy)) !== 2, `finder at ${cx},${cy}`); };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  for (let i = 8; i < size - 8; i++) { assert.equal(modules[6][i], i % 2 === 0); assert.equal(modules[i][6], i % 2 === 0); }
});

test('the codes read back exactly, including the sign-up link the tool shows', () => {
  const link = 'https://easygaragecleaning.com/api/garage-guard-link?s=cs_live_a1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuVwXyZ0123456789abcdefghijkl&k=AbCdEfGhIjKlMnOpQrStUv';
  const cases = [['HELLO', 'M', 1], ['Synthetic 1', 'L', 1], ['Hi — Dana', 'M', 1], ['x'.repeat(40), 'M', 3], ['y'.repeat(20), 'H', 3], [link, 'M', 8], ['z'.repeat(400), 'M', 15], ['q'.repeat(280), 'Q', 15]];
  for (const [text, level, version] of cases) {
    const matrix = qrMatrix(text, { level });
    assert.equal(matrix.version, version, `${text.slice(0, 12)} fits version ${version}`);
    assert.equal(readBack(matrix, level).text, text);
    for (let mask = 0; mask < 8; mask++) assert.equal(readBack(qrMatrix(text, { level, mask }), level).text, text, `mask ${mask}`);
  }
  assert.throws(() => qrMatrix('x'.repeat(700)), /too long/);
  assert.throws(() => qrMatrix('x', { level: 'Z' }), /level/);
});
