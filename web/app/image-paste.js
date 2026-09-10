// Only the native desktop shares the agent process's system clipboard. A remote
// browser's image would need an upload, not a Ctrl+V sent to the host.
export function createImagePasteHandler({ isDesktop, agent, ready, active, hasClipboardImage, pasteImage, report }) {
  let checking = false;
  return (event) => {
    const targetAgent = agent();
    if (!isDesktop() || !['claude', 'codex'].includes(targetAgent) || !active()) return;
    const clipboard = event.clipboardData;
    if (!clipboard) return;
    const image = [...(clipboard.items || [])].some((item) => item.kind === 'file' && item.type.startsWith('image/'))
      || [...(clipboard.types || [])].some((type) => type.startsWith('image/'));
    // Let xterm own ordinary text, including bracketed/multiline paste.
    if (!image && clipboard.getData('text/plain')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (checking) return;
    const attach = () => {
      if (!active() || agent() !== targetAgent) return;
      if (!ready()) { report('Reconnect the terminal, then paste the screenshot again.'); return; }
      pasteImage();
    };
    if (image) { attach(); return; }
    // WebKit may hide TIFF/PNG clipboard items. Query formats only, not contents.
    checking = true;
    Promise.resolve().then(hasClipboardImage).then((present) => {
      if (present) attach();
    }).catch(() => {
      if (active()) report('Screenshot paste needs the updated Keep app. Use Control+V for now.');
    }).finally(() => { checking = false; });
  };
}
