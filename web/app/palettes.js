export const DEFAULT_PALETTE = 'moss';

const REFERENCE_PALETTES = [
  {
    id: 'moss', name: 'Moss', note: 'deep green frame, oat list, sage stage; saffron for needs-you',
    light: { bar: '#2b4a3c', barT: '#e9efe8', barM: '#a3bcae', barLine: '#3a5d4d', barSeg: '#243f33', barSel: '#3f6552', rail: '#f5f1e6', queue: '#ebe6d8', sel: '#e0dac6', shead: '#d8e2d8', answer: '#e5ece4', term: '#f4f7f2', termFg: '#3e4b42', line: '#d3cfc0', line2: '#bdb8a7', t: '#1f2a24', m: '#5b6a61', f: '#8b978f', accent: '#c48a12', accentInk: '#fff8e8', info: '#3c7ea6', ok: '#4f8f5a' },
    dark: { bar: '#0b1512', barT: '#dbe4dc', barM: '#82978a', barLine: '#1a2a23', barSeg: '#101d18', barSel: '#1e3229', rail: '#191816', queue: '#211f1c', sel: '#2c2924', shead: '#1a2622', answer: '#15201c', term: '#0d1512', termFg: '#cad6cd', line: '#2e3632', line2: '#3d4742', t: '#dde5de', m: '#8b9a90', f: '#5d6b63', accent: '#e6b04a', accentInk: '#1c1404', info: '#73aad2', ok: '#7ac48a' },
  },
  {
    id: 'harbor', name: 'Harbor', note: 'navy frame, sand list, sky-grey stage; coral for needs-you',
    light: { bar: '#1f3a5a', barT: '#e8eef5', barM: '#9fb3c9', barLine: '#2c4d72', barSeg: '#193050', barSel: '#33557d', rail: '#f6f0e4', queue: '#ede5d5', sel: '#e3d7bf', shead: '#d4dfe8', answer: '#e2eaf0', term: '#f2f6f9', termFg: '#3a4a5c', line: '#d5cfc0', line2: '#bfb8a7', t: '#1d2a38', m: '#5a6878', f: '#8b97a6', accent: '#c9553d', accentInk: '#fff6f2', info: '#2f6fae', ok: '#3f8f5f' },
    dark: { bar: '#0a1420', barT: '#dbe3ec', barM: '#7f91a6', barLine: '#18263a', barSeg: '#0f1b2b', barSel: '#1c2e46', rail: '#1a1816', queue: '#221f1c', sel: '#2d2924', shead: '#182533', answer: '#141f2b', term: '#0c141d', termFg: '#c9d3de', line: '#2e3540', line2: '#3d4652', t: '#dde3ea', m: '#8b97a6', f: '#5c6775', accent: '#e8735a', accentInk: '#1c0c08', info: '#6ea6e0', ok: '#6cbf8a' },
  },
  {
    id: 'plum', name: 'Plum', note: 'aubergine frame, linen list, lavender-grey stage; gold for needs-you',
    light: { bar: '#3d2b47', barT: '#f0e9f2', barM: '#b7a6bf', barLine: '#523b5e', barSeg: '#33243c', barSel: '#5a4366', rail: '#f7f2ea', queue: '#efe8dc', sel: '#e6dcc8', shead: '#dfd9e6', answer: '#e9e5ee', term: '#f6f4f9', termFg: '#463f4f', line: '#d8d1c4', line2: '#c2baab', t: '#2a2130', m: '#66596e', f: '#958a9b', accent: '#b8860b', accentInk: '#fff8e6', info: '#5b5fb8', ok: '#4f8f6a' },
    dark: { bar: '#150e1b', barT: '#e4dce8', barM: '#9385a0', barLine: '#281c30', barSeg: '#1b1322', barSel: '#2f2239', rail: '#1a1816', queue: '#221f1d', sel: '#2d2926', shead: '#231c2b', answer: '#1d1724', term: '#120d17', termFg: '#d4cdd9', line: '#33303a', line2: '#433f4a', t: '#e3dde7', m: '#978ba1', f: '#665c70', accent: '#e2b035', accentInk: '#1a1304', info: '#9a9ce6', ok: '#78c49a' },
  },
  {
    id: 'graphite', name: 'Graphite', note: 'charcoal frame, warm grey list, cool grey stage; amber for needs-you — the quietest option',
    light: { bar: '#2a2d33', barT: '#e8e9ec', barM: '#9ea3ab', barLine: '#3a3e46', barSeg: '#22252b', barSel: '#40444d', rail: '#f4f2ee', queue: '#ebe8e2', sel: '#dfdbd2', shead: '#dcdfe3', answer: '#e7e9ec', term: '#f5f6f8', termFg: '#3b3f47', line: '#d4d1ca', line2: '#bdb9b1', t: '#22252b', m: '#5f646c', f: '#8f949c', accent: '#c98a12', accentInk: '#fff8e8', info: '#3872b8', ok: '#3f8f5f' },
    dark: { bar: '#0d0e11', barT: '#dcdde0', barM: '#83878f', barLine: '#1d1f24', barSeg: '#13141a', barSel: '#23262d', rail: '#1a1917', queue: '#22211e', sel: '#2d2b27', shead: '#20232a', answer: '#1a1d23', term: '#0f1115', termFg: '#cfd2d8', line: '#2e3036', line2: '#3d4048', t: '#dcdee2', m: '#8b8f97', f: '#5e626a', accent: '#e2a63d', accentInk: '#1a1408', info: '#6aa4e0', ok: '#6cbf8a' },
  },
  {
    id: 'terracotta', name: 'Terracotta', note: 'rust frame, cream list, blue-grey stage; teal for needs-you',
    light: { bar: '#6a3a2e', barT: '#f6ebe6', barM: '#c9a79c', barLine: '#824a3c', barSeg: '#5b3127', barSel: '#8a5245', rail: '#f8f1e6', queue: '#efe6d6', sel: '#e6d9c0', shead: '#d5dde3', answer: '#e2e8ed', term: '#f3f6f8', termFg: '#3b4652', line: '#d7cfc0', line2: '#c1b8a7', t: '#2a2420', m: '#665c56', f: '#968c85', accent: '#1f8a8a', accentInk: '#effafa', info: '#3b6fb0', ok: '#4f8f5a' },
    dark: { bar: '#1c0f0b', barT: '#eadfd9', barM: '#a48e85', barLine: '#301c16', barSeg: '#22140f', barSel: '#3a221b', rail: '#1a1816', queue: '#221f1c', sel: '#2d2924', shead: '#182229', answer: '#141c22', term: '#0d1317', termFg: '#cbd4dc', line: '#2f3338', line2: '#3f444a', t: '#e3ddd8', m: '#998f89', f: '#6a615b', accent: '#3fbcb8', accentInk: '#062020', info: '#7aa8e0', ok: '#7ac48a' },
  },
  {
    id: 'midnight', name: 'Midnight', note: 'one dark world: the light version is a dim slate, the dark version near black; electric blue for needs-you',
    light: { bar: '#1b1f2a', barT: '#e6e8f0', barM: '#9aa1b5', barLine: '#2a3040', barSeg: '#151924', barSel: '#2f3648', rail: '#e9ebf0', queue: '#dfe2e9', sel: '#d0d5e0', shead: '#d3d9e4', answer: '#dee3ec', term: '#f2f4f8', termFg: '#2e3444', line: '#c7ccd8', line2: '#b1b7c5', t: '#1c2130', m: '#596178', f: '#8a91a4', accent: '#2f6df6', accentInk: '#f3f6ff', info: '#2f6df6', ok: '#2f9e63' },
    dark: { bar: '#07080d', barT: '#e2e5ee', barM: '#7f869c', barLine: '#161a26', barSeg: '#0c0e16', barSel: '#1a1f2e', rail: '#111319', queue: '#171a22', sel: '#20242f', shead: '#151a27', answer: '#111622', term: '#0a0d14', termFg: '#d3d7e2', line: '#252a37', line2: '#333949', t: '#e0e4ee', m: '#8a91a6', f: '#5b6178', accent: '#5b8dff', accentInk: '#061029', info: '#5b8dff', ok: '#5ec98c' },
  },
];

function channels(hex) {
  return [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
}

function mix(from, toward, amount) {
  const a = channels(from);
  const b = channels(toward);
  return `#${a.map((value, index) => Math.round(value + (b[index] - value) * amount).toString(16).padStart(2, '0')).join('')}`;
}

function alpha(hex, opacity) {
  const [red, green, blue] = channels(hex);
  return `rgba(${red},${green},${blue},${opacity})`;
}

function consoleTokens(source, id, mode) {
  const coral = id === 'harbor' || id === 'terracotta';
  const bad = coral ? (mode === 'light' ? '#b3322c' : '#ff8c78') : (mode === 'light' ? '#c9403a' : '#e06c5c');
  const violet = id === 'midnight' ? (mode === 'light' ? '#7a5af5' : '#a58bff') : (mode === 'light' ? '#6c71c4' : '#a58be0');
  return {
    '--bar-bg': source.bar,
    '--bar-text': source.barT,
    '--bar-muted': source.barM,
    '--bar-line': source.barLine,
    '--bar-seg': source.barSeg,
    '--bar-sel': source.barSel,
    '--rail-bg': source.rail,
    '--bg': source.rail,
    '--panel': source.queue,
    '--panel-2': mix(source.queue, source.t, 0.04),
    '--sel': source.sel,
    '--shead-bg': source.shead,
    '--answer-bg': source.answer,
    '--term-bg': source.term,
    '--term-fg': source.termFg,
    '--term-dim': source.f,
    '--term-line': source.line,
    '--line': source.line,
    '--line-2': source.line2,
    '--text': source.t,
    '--muted': source.m,
    '--faint': source.f,
    '--accent': source.accent,
    '--warn': source.accent,
    '--accent-ink': source.accentInk,
    '--ic-ink': source.accentInk,
    '--accent-soft': alpha(source.accent, '.16'),
    '--info': source.info,
    '--focus': source.info,
    '--scope-line': source.info,
    '--ok': source.ok,
    '--bad': bad,
    '--bad-soft': alpha(bad, '.12'),
    '--violet': violet,
    '--shadow': mode === 'light' ? '0 8px 24px rgba(0,0,0,.14)' : '0 8px 24px rgba(0,0,0,.35)',
    '--backdrop': mode === 'light' ? 'rgba(20,30,40,.35)' : 'rgba(0,0,0,.65)',
    '--pj-bg-l': mode === 'light' ? '45%' : '50%',
    '--pj-bg-alpha': '.16',
    '--pj-dot-l': mode === 'light' ? '40%' : '55%',
  };
}

const SOLAR = {
  id: 'solar',
  name: 'Solar',
  note: 'the original Solarized-derived Keep console palette',
  dark: {
    '--bg': '#15171c', '--panel': '#1f1d21', '--panel-2': '#26232a', '--line': '#2c313a', '--line-2': '#3a404a',
    '--text': '#d8dbe0', '--muted': '#8b919b', '--faint': '#5f6570', '--accent': '#e2a63d', '--accent-ink': '#1a1408',
    '--accent-soft': 'rgba(226,166,61,.14)', '--ok': '#5fb37a', '--warn': '#e2a63d', '--bad': '#e06c5c',
    '--info': '#6aa4e0', '--violet': '#a58be0', '--sel': '#2b2730', '--focus': '#6aa4e0',
    '--term-bg': '#0d141b', '--term-fg': '#cfd3d8', '--term-dim': '#6b717b', '--term-line': '#2a2e35',
    '--bad-soft': 'rgba(224,108,92,.12)', '--shadow': '0 8px 24px rgba(0,0,0,.35)', '--backdrop': 'rgba(0,0,0,.65)',
    '--scope-line': 'hsl(210 40% 40%)', '--pj-bg-l': '50%', '--pj-bg-alpha': '.16', '--pj-dot-l': '55%',
    '--ic-ink': 'var(--bg)', '--bar-bg': '#0b1219', '--bar-text': '#d8dbe0', '--bar-muted': '#8794a3', '--bar-line': '#1b2733',
    '--bar-seg': '#111a24', '--bar-sel': '#1e2b39', '--rail-bg': '#17161a', '--shead-bg': '#1e2a36', '--answer-bg': '#182229',
  },
  light: {
    '--bg': '#fdf6e3', '--panel': '#eee8d5', '--panel-2': '#e4ddc8', '--line': '#d9d2bc', '--line-2': '#c9c1a9',
    '--text': '#073642', '--muted': '#586e75', '--faint': '#839496', '--accent': '#8a6800', '--accent-ink': '#fdf6e3',
    '--accent-soft': 'rgba(138,104,0,.16)', '--ok': '#6f8000', '--warn': '#8a6800', '--bad': '#dc322f',
    '--info': '#1e6ea6', '--violet': '#6c71c4', '--sel': '#e6dcc2', '--focus': '#1e6ea6',
    '--term-bg': '#f3f7f7', '--term-fg': '#4f6367', '--term-dim': '#93a1a1', '--term-line': '#d9d2bc',
    '--bad-soft': 'rgba(220,50,47,.12)', '--shadow': '0 8px 24px rgba(88,110,117,.18)', '--backdrop': 'rgba(7,54,66,.35)',
    '--scope-line': '#268bd2', '--pj-bg-l': '45%', '--pj-bg-alpha': '.16', '--pj-dot-l': '40%',
    '--ic-ink': '#fdf6e3', '--bar-bg': '#2e4a56', '--bar-text': '#eee8d5', '--bar-muted': '#a7b8b8', '--bar-line': '#3d5c68',
    '--bar-seg': '#26404b', '--bar-sel': '#43626e', '--rail-bg': '#f7f0dc', '--shead-bg': '#d6e1e5', '--answer-bg': '#e3ecee',
  },
};

export const PALETTES = [
  ...REFERENCE_PALETTES.map((palette) => ({
    id: palette.id,
    name: palette.name,
    note: palette.note,
    light: consoleTokens(palette.light, palette.id, 'light'),
    dark: consoleTokens(palette.dark, palette.id, 'dark'),
  })),
  SOLAR,
];

export function paletteById(id) {
  return PALETTES.find((palette) => palette.id === id) || PALETTES[0];
}

export function swatches(palette, mode) {
  const tokens = palette[mode];
  return [tokens['--bar-bg'], tokens['--panel'], tokens['--shead-bg'], tokens['--accent']];
}
