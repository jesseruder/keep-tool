import { DEFAULT_PALETTE, paletteById } from './palettes.js';

export const THEMES = {
  dark: {
    black: '#15171c', red: '#e06c5c', green: '#6fbf8a',
    yellow: '#e2a63d', blue: '#7fb2e8', magenta: '#a58be0', cyan: '#70b9b0', white: '#d8dbe0',
    brightBlack: '#6b717b', brightRed: '#ed8173', brightGreen: '#83ce9c', brightYellow: '#efb858',
    brightBlue: '#91c0ef', brightMagenta: '#b9a3e8', brightCyan: '#8bcac2', brightWhite: '#f1f2f4',
  },
  light: {
    black: '#073642', red: '#dc322f', green: '#859900',
    yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
    brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#93a1a1', brightYellow: '#839496',
    brightBlue: '#657b83', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
  },
};

const STORAGE_KEY = 'keep.console.theme';
const PALETTE_STORAGE_KEY = 'keep.console.palette';
const PREFERENCES = new Set(['system', 'light', 'dark']);
const subscribers = new Set();
const lightQuery = window.matchMedia('(prefers-color-scheme: light)');

export function getPreference() {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return PREFERENCES.has(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

export function setPreference(value) {
  const preference = PREFERENCES.has(value) ? value : 'system';
  try { localStorage.setItem(STORAGE_KEY, preference); } catch {}
  return preference;
}

export function getPalette() {
  try {
    return paletteById(localStorage.getItem(PALETTE_STORAGE_KEY)).id;
  } catch {
    return DEFAULT_PALETTE;
  }
}

export function setPalette(id) {
  const palette = paletteById(id).id;
  try { localStorage.setItem(PALETTE_STORAGE_KEY, palette); } catch {}
  return palette;
}

export function resolvedTheme() {
  const preference = getPreference();
  return preference === 'system' ? (lightQuery.matches ? 'light' : 'dark') : preference;
}

export function applyTheme() {
  const preference = getPreference();
  if (preference === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset.theme = preference;
  const appearance = { mode: resolvedTheme(), palette: getPalette() };
  document.documentElement.dataset.palette = appearance.palette;
  for (const subscriber of subscribers) subscriber(appearance);
  return appearance;
}

export function onThemeChange(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

lightQuery.addEventListener('change', () => {
  if (getPreference() === 'system') applyTheme();
});

function withAlpha(hex, opacity) {
  const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
  return `rgba(${channels.join(',')},${opacity})`;
}

export function xtermTheme(mode, paletteId) {
  const resolvedMode = mode === 'light' ? 'light' : 'dark';
  const tokens = paletteById(paletteId)[resolvedMode];
  return {
    ...THEMES[resolvedMode],
    background: tokens['--term-bg'],
    foreground: tokens['--term-fg'],
    cursor: tokens['--text'],
    cursorAccent: tokens['--term-bg'],
    selectionBackground: withAlpha(tokens['--sel'], '.55'),
  };
}
