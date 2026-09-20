// Claude and Codex use local Simple Icons marks. Pi uses a typographic π mark.
const PROVIDERS = {
  claude: { label: 'Claude Code' },
  codex: { label: 'Codex' },
  pi: { label: 'Pi', glyph: 'π' },
};

export function providerIconHTML(kind, esc) {
  const provider = PROVIDERS[kind];
  if (!provider) return '';
  const label = esc(provider.label);
  return `<span class="provider-icon provider-${kind}" role="img" aria-label="${label}" title="${label}">${provider.glyph || ''}</span>`;
}
