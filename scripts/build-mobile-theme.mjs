import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_PALETTE as CONSOLE_DEFAULT_PALETTE, PALETTES as CONSOLE_PALETTES } from '../web/app/palettes.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'app/theme.js');

function mobilePalette(palette) {
  const modes = Object.fromEntries(['light', 'dark'].map((mode) => [
    mode,
    Object.fromEntries(Object.entries(palette[mode]).map(([key, value]) => [key.replace(/^--/, ''), value])),
  ]));
  return { id: palette.id, name: palette.name, note: palette.note, ...modes };
}

export function render() {
  const palettes = CONSOLE_PALETTES.map(mobilePalette);
  return `// generated — do not edit\n\nexport const PALETTES = ${JSON.stringify(palettes, null, 2)};\n\nexport const DEFAULT_PALETTE = ${JSON.stringify(CONSOLE_DEFAULT_PALETTE)};\n\nfunction camel(name) {\n  return name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());\n}\n\nexport function themeFor(paletteId, scheme) {\n  const palette = PALETTES.find((candidate) => candidate.id === paletteId) || PALETTES.find((candidate) => candidate.id === DEFAULT_PALETTE);\n  const tokens = palette[scheme === 'dark' ? 'dark' : 'light'];\n  const aliases = Object.fromEntries(Object.entries(tokens).map(([name, value]) => [camel(name), value]));\n  return { ...tokens, ...aliases, hairline: tokens.line, paletteId: palette.id, scheme: scheme === 'dark' ? 'dark' : 'light' };\n}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(target, render());
  fs.copyFileSync(new URL('../web/app/shared/scope-rules.js', import.meta.url), new URL('../app/src/scope-rules.js', import.meta.url));
}
