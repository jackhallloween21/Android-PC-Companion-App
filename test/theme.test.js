'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  DEFAULT_ACCENT,
  ACCENT_PRESETS,
  normalizeHex,
  hexToRgb,
  rgba,
  luminance,
  accentInkOn,
  accentVars,
  resolveMode,
  accentTextFor,
  sanitizeSettings,
} = require('../src/theme');

const LIGHT_BG_L = luminance('#eef1f6');
const contrastRatio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

test('normalizeHex accepts #rrggbb, #rgb and bare hex, canonically lowercased', () => {
  assert.strictEqual(normalizeHex('#F5A524'), '#f5a524');
  assert.strictEqual(normalizeHex('f5a524'), '#f5a524');
  assert.strictEqual(normalizeHex('#ABC'), '#aabbcc');
  assert.strictEqual(normalizeHex('  #3B82F6  '), '#3b82f6');
});

test('normalizeHex rejects anything it cannot trust', () => {
  for (const bad of ['', 'red', '#12', '#12345', '#gggggg', '#1234567', null, undefined, 42, {}]) {
    assert.strictEqual(normalizeHex(bad), null, `${String(bad)} should be rejected`);
  }
});

test('rgba reproduces the accent-dim literal the CSS derives from --accent-rgb', () => {
  assert.strictEqual(rgba('#f5a524', 0.14), 'rgba(245, 165, 36, 0.14)');
  assert.strictEqual(accentVars('#f5a524')['--accent-rgb'], '245, 165, 36');
});

test('rgba clamps alpha and refuses a bad colour', () => {
  assert.strictEqual(rgba('#000000', 2), 'rgba(0, 0, 0, 1)');
  assert.strictEqual(rgba('#000000', -1), 'rgba(0, 0, 0, 0)');
  assert.strictEqual(rgba('nope', 0.5), null);
});

test('hexToRgb parses channels, null on garbage', () => {
  assert.deepStrictEqual(hexToRgb('#3b82f6'), { r: 59, g: 130, b: 246 });
  assert.strictEqual(hexToRgb('xyz'), null);
});

test('accentVars returns null for an invalid accent so callers fall back', () => {
  assert.strictEqual(accentVars('not-a-colour'), null);
  const v = accentVars('#3b82f6');
  assert.strictEqual(v['--accent'], '#3b82f6');
  assert.strictEqual(v['--accent-rgb'], '59, 130, 246');
  assert.strictEqual(v['--accent-ink'], '#10151d');
});

test('accentInkOn picks the higher-contrast glyph colour for each accent', () => {
  assert.strictEqual(accentInkOn('#ffffff'), '#10151d');
  assert.strictEqual(accentInkOn('#f5a524'), '#10151d'); // amber: ~9:1 dark vs ~2:1 white
  assert.strictEqual(accentInkOn('#2dd4bf'), '#10151d'); // bright teal
  assert.strictEqual(accentInkOn('#3b82f6'), '#10151d'); // blue: ~5:1 dark beats sub-AA white
  assert.strictEqual(accentInkOn('#1a2233'), '#ffffff'); // near-black accent -> white
  assert.strictEqual(accentInkOn('#0a0e14'), '#ffffff');
});;

test('resolveMode maps auto through the OS preference', () => {
  assert.strictEqual(resolveMode('auto', true), 'dark');
  assert.strictEqual(resolveMode('auto', false), 'light');
  assert.strictEqual(resolveMode('light', true), 'light');
  assert.strictEqual(resolveMode('dark', false), 'dark');
  assert.strictEqual(resolveMode('garbage', false), 'dark');
});

test('accentTextFor leaves the accent untouched in dark mode', () => {
  for (const p of ACCENT_PRESETS) {
    assert.strictEqual(accentTextFor(p.hex, 'dark'), p.hex, `${p.name} unchanged on dark`);
  }
  assert.strictEqual(accentTextFor('#f5a524', 'dark'), '#f5a524');
  assert.strictEqual(accentTextFor('bad-colour', 'light'), null);
});

test('accentTextFor darkens every preset to clear AA on the light ground', () => {
  for (const p of ACCENT_PRESETS) {
    const text = accentTextFor(p.hex, 'light');
    assert.ok(normalizeHex(text), `${p.name} -> valid hex`);
    const ratio = contrastRatio(luminance(text), LIGHT_BG_L);
    assert.ok(ratio >= 4.5, `${p.name} text contrast ${ratio.toFixed(2)} should clear 4.5:1 on light`);
  }
});

test('sanitizeSettings coerces junk into a valid mode + accent', () => {
  assert.deepStrictEqual(sanitizeSettings(null), { mode: 'dark', accent: DEFAULT_ACCENT });
  assert.deepStrictEqual(sanitizeSettings({}), { mode: 'dark', accent: DEFAULT_ACCENT });
  assert.deepStrictEqual(sanitizeSettings({ mode: 'light', accent: '#ABC' }), { mode: 'light', accent: '#aabbcc' });
  assert.deepStrictEqual(sanitizeSettings({ mode: 'nope', accent: 'nope' }), { mode: 'dark', accent: DEFAULT_ACCENT });
  assert.deepStrictEqual(sanitizeSettings({ mode: 'auto', accent: '#22c55e' }), { mode: 'auto', accent: '#22c55e' });
});

test('the curated presets are all valid, distinct, and include the default', () => {
  const seen = new Set();
  for (const p of ACCENT_PRESETS) {
    assert.strictEqual(normalizeHex(p.hex), p.hex, `${p.name} should already be canonical`);
    assert.ok(!seen.has(p.hex), `${p.hex} duplicated`);
    seen.add(p.hex);
    assert.ok(typeof p.name === 'string' && p.name.length > 0, 'preset needs a name');
  }
  assert.ok(ACCENT_PRESETS.some((p) => p.hex === DEFAULT_ACCENT), 'default accent should be offered as a swatch');
});
