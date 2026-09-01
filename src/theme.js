'use strict';

// Theme helpers: accent-colour maths and light/dark/auto mode resolution.
//
// Kept pure (no DOM, no electron) so the main process (which persists and
// sanitises settings) and the renderer (which paints them) agree on what a
// valid accent or mode is, and so the logic is unit-testable. The renderer
// cannot require() from src/, so it carries a tiny mirror of applyTheme; this
// module stays the single source of truth for the *values*.

const DEFAULT_ACCENT = '#f5a524';
const DEFAULT_MODE = 'dark';
const THEME_MODES = ['dark', 'light', 'auto'];

// Curated accents offered as one-click swatches, spread around the hue wheel so
// each stays clearly distinct on both the near-black and the near-white
// surface. The default amber is included so the swatch row reflects the
// out-of-the-box state.
const ACCENT_PRESETS = [
  { name: 'Amber', hex: '#f5a524' },
  { name: 'Coral', hex: '#fb7185' },
  { name: 'Teal', hex: '#2dd4bf' },
  { name: 'Blue', hex: '#3b82f6' },
  { name: 'Violet', hex: '#8b5cf6' },
  { name: 'Green', hex: '#22c55e' },
  { name: 'Cyan', hex: '#38bdf8' },
  { name: 'Pink', hex: '#ec4899' },
];

// Accept "#rgb", "#rrggbb", or the same without the leading '#'. Returns a
// canonical lowercase "#rrggbb", or null if it is not a colour we can trust.
function normalizeHex(input) {
  if (typeof input !== 'string') return null;
  let s = input.trim().toLowerCase();
  if (s.startsWith('#')) s = s.slice(1);
  if (/^[0-9a-f]{3}$/.test(s)) s = s.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/.test(s)) return null;
  return `#${s}`;
}

function hexToRgb(hex) {
  const norm = normalizeHex(hex);
  if (!norm) return null;
  return {
    r: parseInt(norm.slice(1, 3), 16),
    g: parseInt(norm.slice(3, 5), 16),
    b: parseInt(norm.slice(5, 7), 16),
  };
}

// Alpha is clamped to [0,1]. The output deliberately matches the spacing of the
// hand-written rgba() literals it replaces (e.g. "rgba(245, 165, 36, 0.14)"),
// so routing the old CSS through it leaves dark mode byte-identical.
function rgba(hex, alpha) {
  const c = hexToRgb(hex);
  if (!c) return null;
  let a = Number(alpha);
  if (!Number.isFinite(a)) a = 1;
  a = Math.min(1, Math.max(0, a));
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`;
}

// Relative luminance (WCAG) — lets the UI choose black vs white for glyphs
// drawn ON a solid accent fill.
function luminance(hex) {
  const c = hexToRgb(hex);
  if (!c) return 0;
  const lin = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

// Text/glyph colour to place on top of a solid accent fill: whichever of the
// near-black or white ink has the higher WCAG contrast against the accent.
// A fixed luminance threshold misjudges mid-tone accents (amber sits right on
// 0.5 yet takes ~9:1 with dark ink versus ~2:1 with white), so compare the
// actual contrast ratios instead.
const ACCENT_INK_DARK = '#10151d';
const ACCENT_INK_LIGHT = '#ffffff';
function accentInkOn(hex) {
  if (!hexToRgb(hex)) return ACCENT_INK_LIGHT;
  const L = luminance(hex);
  const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  const withDark = contrast(L, luminance(ACCENT_INK_DARK));
  const withLight = contrast(L, luminance(ACCENT_INK_LIGHT));
  return withDark >= withLight ? ACCENT_INK_DARK : ACCENT_INK_LIGHT;
}

// The CSS custom properties a chosen accent drives. --accent-rgb feeds the
// rgba() washes/glows and --accent-ink is the readable glyph colour on a solid
// fill, so one chosen colour recolours fills, soft backgrounds, the ambient
// page glow and on-accent text together. --accent-dim is derived in CSS from
// --accent-rgb, so it is intentionally not returned here.
function accentVars(hex) {
  const norm = normalizeHex(hex);
  if (!norm) return null;
  const c = hexToRgb(norm);
  return {
    '--accent': norm,
    '--accent-rgb': `${c.r}, ${c.g}, ${c.b}`,
    '--accent-ink': accentInkOn(norm),
  };
}

// Collapse auto -> dark|light using the OS preference; anything unrecognised
// falls back to the default mode.
function resolveMode(mode, osPrefersDark) {
  const m = THEME_MODES.includes(mode) ? mode : DEFAULT_MODE;
  if (m === 'auto') return osPrefersDark ? 'dark' : 'light';
  return m;
}

// The light theme's ground colour, kept in step with --bg-base in the
// .theme-light CSS block.
const LIGHT_BG = '#eef1f6';

// Accent colour to use for *text*. On a dark ground the bright accent already
// reads, so it is returned unchanged (keeping dark mode byte-identical). On the
// light ground a bright accent (amber, cyan) is unreadable as text, so it is
// darkened toward black in 15% steps — preserving hue — until it clears WCAG AA
// (4.5:1) against the light background. resolvedMode must already be dark|light.
function accentTextFor(hex, resolvedMode) {
  const norm = normalizeHex(hex);
  if (!norm) return null;
  if (resolvedMode !== 'light') return norm;
  const bgL = luminance(LIGHT_BG);
  const ratio = (l) => (Math.max(l, bgL) + 0.05) / (Math.min(l, bgL) + 0.05);
  const toHex = (o) => `#${[o.r, o.g, o.b]
    .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
    .join('')}`;
  let cur = hexToRgb(norm);
  for (let i = 0; i < 24; i += 1) {
    const h = toHex(cur);
    if (ratio(luminance(h)) >= 4.5) return h;
    cur = { r: cur.r * 0.85, g: cur.g * 0.85, b: cur.b * 0.85 };
  }
  return '#0b0f14';
}

// Coerce whatever we read from settings.json (possibly hand-edited or corrupt)
// into a valid { mode, accent }. Never throws.
function sanitizeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const mode = THEME_MODES.includes(src.mode) ? src.mode : DEFAULT_MODE;
  const accent = normalizeHex(src.accent) || DEFAULT_ACCENT;
  return { mode, accent };
}

module.exports = {
  DEFAULT_ACCENT,
  DEFAULT_MODE,
  THEME_MODES,
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
};
