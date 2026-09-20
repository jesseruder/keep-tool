// Provider marks are local copies of the Simple Icons v15 OpenAI and Claude
// SVGs. CSS masks keep the source art legible on every console palette.
const PROVIDERS = {
  claude: { label: 'Claude Code' },
  codex: { label: 'Codex' },
};

export function providerIconHTML(kind, esc) {
  const provider = PROVIDERS[kind];
  if (!provider) return '';
  const label = esc(provider.label);
  return `<span class="provider-icon provider-${kind}" role="img" aria-label="${label}" title="${label}"></span>`;
}
