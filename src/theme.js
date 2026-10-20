'use strict';
// Appearance options each user can choose under Account > Appearance.

const MODES = [
  { value: 'auto', label: 'Automatic', help: 'Follow the setting on this phone or computer' },
  { value: 'light', label: 'Light', help: 'Dark text on a light background' },
  { value: 'dark', label: 'Dark', help: 'Light text on a dark background, easier at night' },
];

const ACCENTS = [
  { value: 'green', label: 'KDLA green', swatch: '#1f6b3a' },
  { value: 'blue', label: 'Lake blue', swatch: '#1d5fa8' },
  { value: 'terracotta', label: 'Copperbelt copper', swatch: '#a8461d' },
  { value: 'plum', label: 'Plum', swatch: '#6d3a80' },
];

const TEXT_SIZES = [
  { value: 'normal', label: 'Standard' },
  { value: 'large', label: 'Larger text' },
];

const DEFAULT = { mode: 'auto', accent: 'green', textSize: 'normal' };

const has = (list, v) => list.some((x) => x.value === v);

function themeOf(user) {
  const t = (user && user.theme) || {};
  return {
    mode: has(MODES, t.mode) ? t.mode : DEFAULT.mode,
    accent: has(ACCENTS, t.accent) ? t.accent : DEFAULT.accent,
    textSize: has(TEXT_SIZES, t.textSize) ? t.textSize : DEFAULT.textSize,
  };
}

/** Validate a submitted theme; unknown values fall back to the current ones. */
function readTheme(body, current) {
  const base = themeOf({ theme: current });
  return {
    mode: has(MODES, body.mode) ? body.mode : base.mode,
    accent: has(ACCENTS, body.accent) ? body.accent : base.accent,
    textSize: has(TEXT_SIZES, body.textSize) ? body.textSize : base.textSize,
  };
}

module.exports = {
  MODES, ACCENTS, TEXT_SIZES, themeOf, readTheme,
};
