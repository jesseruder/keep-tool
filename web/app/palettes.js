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
  {
    id: 'evergreen', name: 'Evergreen', note: 'after Everforest: a sage daylight frame with dark type, cream list, meadow stage; orange for needs-you',
    light: { bar: '#bdc3af', barT: '#2f383e', barM: '#56645a', barLine: '#a9b09a', barSeg: '#b3b9a4', barSel: '#a6ae97', rail: '#fdf6e3', queue: '#f4f0d9', sel: '#e6e2cc', shead: '#e5ecde', answer: '#edf0dd', term: '#fffbef', termFg: '#5c6a72', line: '#e0dcc7', line2: '#c9c9b4', t: '#3a454b', m: '#6b7a74', f: '#939f91', accent: '#c45f10', accentInk: '#fff6ea', info: '#2f7fa8', ok: '#6c8200' },
    dark: { bar: '#232a2e', barT: '#d3c6aa', barM: '#859289', barLine: '#343f44', barSeg: '#1e2427', barSel: '#3d484d', rail: '#2d353b', queue: '#343f44', sel: '#3d484d', shead: '#2e3d3d', answer: '#34423a', term: '#272e33', termFg: '#d3c6aa', line: '#414b50', line2: '#4f585e', t: '#d3c6aa', m: '#9da9a0', f: '#7a8478', accent: '#e69875', accentInk: '#2d1a10', info: '#7fbbb3', ok: '#a7c080' },
  },
  {
    id: 'fog', name: 'Fog', note: 'a blue-grey daylight frame with dark type, cool white list, linen stage; lagoon teal for needs-you',
    light: { bar: '#b6c3cc', barT: '#1d2a33', barM: '#4b5c67', barLine: '#a1b0ba', barSeg: '#aab8c2', barSel: '#98a8b3', rail: '#f7f9fa', queue: '#eef2f4', sel: '#dfe6eb', shead: '#f1ece1', answer: '#f5f1e8', term: '#fcfcfb', termFg: '#35414a', line: '#d9e0e5', line2: '#bfcad1', t: '#18242c', m: '#52626c', f: '#8796a0', accent: '#0b7a86', accentInk: '#effbfc', info: '#2f6ea3', ok: '#3f8a5a' },
    dark: { bar: '#27313a', barT: '#dde5ea', barM: '#8fa0ab', barLine: '#35414b', barSeg: '#1f2830', barSel: '#3d4a55', rail: '#161a1d', queue: '#1c2125', sel: '#262d33', shead: '#231f19', answer: '#26211a', term: '#111416', termFg: '#ced7dc', line: '#2b3238', line2: '#3a434a', t: '#e1e7eb', m: '#93a1aa', f: '#5f6c74', accent: '#3fc4cf', accentInk: '#032024', info: '#76b0e0', ok: '#6cc493' },
  },
  {
    id: 'hush', name: 'Hush', note: 'after Zenburn: deliberately low contrast for long sessions, warm greys throughout; soft gold for needs-you',
    light: { bar: '#3f3f3f', barT: '#dcdccc', barM: '#a8a898', barLine: '#4f4f4f', barSeg: '#383838', barSel: '#5a5a5a', rail: '#e4e3da', queue: '#dad9cf', sel: '#cbcabe', shead: '#d3dacf', answer: '#dadfd3', term: '#ecebe3', termFg: '#3f3f3f', line: '#c6c5b9', line2: '#b0afa2', t: '#2f2f2f', m: '#5f5f55', f: '#8a8a7e', accent: '#9c6a1a', accentInk: '#fff6e4', info: '#3a7c86', ok: '#4f7a4f' },
    dark: { bar: '#2b2b2b', barT: '#dcdccc', barM: '#9f9f8f', barLine: '#383838', barSeg: '#262626', barSel: '#4f4f4f', rail: '#3f3f3f', queue: '#464646', sel: '#565656', shead: '#3f4a44', answer: '#3f4740', term: '#353535', termFg: '#dcdccc', line: '#4f4f4f', line2: '#5f5f5f', t: '#dcdccc', m: '#a8a898', f: '#7f7f70', accent: '#e8b86a', accentInk: '#2b2b2b', info: '#8cd0d3', ok: '#7f9f7f' },
  },
  {
    id: 'fjord', name: 'Fjord', note: 'petrol frame, cool white list, frost stage; tangerine for needs-you — the first non-cream light',
    light: { bar: '#1d4450', barT: '#e6f0f1', barM: '#94b3b8', barLine: '#2a5663', barSeg: '#173a45', barSel: '#2f5f6c', rail: '#f3f6f7', queue: '#e8eef0', sel: '#d6e2e6', shead: '#dde9ec', answer: '#e4eef0', term: '#fbfcfc', termFg: '#34454b', line: '#cfdade', line2: '#b5c5ca', t: '#16262c', m: '#50656c', f: '#8699a0', accent: '#c8561a', accentInk: '#fff4ec', info: '#2b6c9e', ok: '#3d8a5c' },
    dark: { bar: '#081a1f', barT: '#d6e5e8', barM: '#7a979d', barLine: '#14303a', barSeg: '#0d232a', barSel: '#1a3a44', rail: '#11181b', queue: '#172024', sel: '#1f2d33', shead: '#132830', answer: '#10232a', term: '#0a1316', termFg: '#c8d8dc', line: '#24343a', line2: '#33464d', t: '#dbe7ea', m: '#86a0a7', f: '#566d74', accent: '#ff9b5c', accentInk: '#2a1204', info: '#6fb3e0', ok: '#6cc497' },
  },
  {
    id: 'hearth', name: 'Hearth', note: 'retro warm, after Gruvbox: bark frame, parchment list, olive stage; amber for needs-you',
    light: { bar: '#3c3836', barT: '#fbf1c7', barM: '#bdae93', barLine: '#504945', barSeg: '#32302f', barSel: '#57504a', rail: '#fbf1c7', queue: '#f2e5bc', sel: '#e8d7a8', shead: '#e3e2c2', answer: '#eae6c6', term: '#fcf6de', termFg: '#3c3836', line: '#d5c4a1', line2: '#bdae93', t: '#282828', m: '#665c54', f: '#928374', accent: '#a3610b', accentInk: '#fff8e1', info: '#076678', ok: '#79740e' },
    dark: { bar: '#1d2021', barT: '#ebdbb2', barM: '#a89984', barLine: '#32302f', barSeg: '#282828', barSel: '#3c3836', rail: '#282828', queue: '#32302f', sel: '#3c3836', shead: '#2b302a', answer: '#2e2f27', term: '#1d2021', termFg: '#ebdbb2', line: '#3c3836', line2: '#504945', t: '#ebdbb2', m: '#a89984', f: '#7c6f64', accent: '#fabd2f', accentInk: '#282828', info: '#83a598', ok: '#b8bb26' },
  },
  {
    id: 'ink', name: 'Ink', note: 'high contrast: black frame, white list, black type; electric blue for needs-you, teal for links',
    light: { bar: '#000000', barT: '#ffffff', barM: '#b8b8b8', barLine: '#2a2a2a', barSeg: '#141414', barSel: '#333333', rail: '#ffffff', queue: '#f4f4f4', sel: '#e0e0e0', shead: '#ededed', answer: '#f5f5f5', term: '#ffffff', termFg: '#111111', line: '#cfcfcf', line2: '#9e9e9e', t: '#000000', m: '#3d3d3d', f: '#6b6b6b', accent: '#0038e0', accentInk: '#ffffff', info: '#006d77', ok: '#1c7a3a' },
    dark: { bar: '#000000', barT: '#ffffff', barM: '#bdbdbd', barLine: '#2e2e2e', barSeg: '#111111', barSel: '#2a2a2a', rail: '#000000', queue: '#0e0e0e', sel: '#262626', shead: '#161616', answer: '#121212', term: '#000000', termFg: '#f2f2f2', line: '#333333', line2: '#555555', t: '#ffffff', m: '#c2c2c2', f: '#8a8a8a', accent: '#6b9bff', accentInk: '#000000', info: '#3fd0d8', ok: '#4ee07a' },
  },
  {
    id: 'sandstone', name: 'Sandstone', note: 'a daylight frame: sand bar with dark type, bone list, sage stage; turquoise for needs-you',
    light: { bar: '#cdb994', barT: '#2b2418', barM: '#665a42', barLine: '#b8a37b', barSeg: '#c0ab84', barSel: '#b39c72', rail: '#faf6ee', queue: '#f3ecdf', sel: '#e9ddc5', shead: '#e0ebe8', answer: '#e8f0ed', term: '#fcfaf5', termFg: '#3d3a33', line: '#e2d7c2', line2: '#cdbfa4', t: '#2a241b', m: '#6b604f', f: '#9c917e', accent: '#0a7f8c', accentInk: '#effcfc', info: '#3a64a8', ok: '#557f2f' },
    dark: { bar: '#2a241a', barT: '#eadfca', barM: '#a8987a', barLine: '#3a3224', barSeg: '#221d15', barSel: '#443a2a', rail: '#1b1814', queue: '#221e19', sel: '#2e2922', shead: '#16211f', answer: '#141e1c', term: '#0f1413', termFg: '#d2d6cf', line: '#302b24', line2: '#433c32', t: '#ece4d6', m: '#a39885', f: '#6d6454', accent: '#39c2c4', accentInk: '#032021', info: '#88a8e0', ok: '#9ec46a' },
  },
  {
    id: 'abyss', name: 'Abyss', note: 'one deep-sea world: the light version is dim teal, the dark version nearly black-green; sodium yellow for needs-you',
    light: { bar: '#0f2a2e', barT: '#dcecec', barM: '#8fb0b0', barLine: '#1d3c40', barSeg: '#0b2226', barSel: '#23474b', rail: '#e3ebea', queue: '#d9e3e2', sel: '#c8d6d4', shead: '#cfdcdb', answer: '#d6e2e0', term: '#eef4f3', termFg: '#243a3c', line: '#bfcfcd', line2: '#a6b9b7', t: '#112426', m: '#4a6466', f: '#7f9695', accent: '#9a6a00', accentInk: '#fff6e0', info: '#2a6f99', ok: '#2f8a5e' },
    dark: { bar: '#031214', barT: '#d3e8e6', barM: '#6f9290', barLine: '#0c2427', barSeg: '#061a1d', barSel: '#10302f', rail: '#0a1a1c', queue: '#0e2124', sel: '#153033', shead: '#0c2629', answer: '#0b2226', term: '#061315', termFg: '#c5dcda', line: '#1a3336', line2: '#264447', t: '#d8ebe9', m: '#7ea09e', f: '#4f6e6c', accent: '#ffc24a', accentInk: '#1f1500', info: '#63b6e6', ok: '#5fd39a' },
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
