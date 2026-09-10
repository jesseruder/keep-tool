import { isDesktop, playAttentionSound } from './shell.js';

// Follow the displayed queue, including local dismissals, without sounding on boot.
export function installAttentionSound() {
  const button = document.querySelector('#soundButton');
  let previous;
  const seen = new Set();
  let muted = false;
  try { muted = localStorage.getItem('keep-attention-muted') === '1'; } catch {}
  button.hidden = !isDesktop();
  function render() {
    button.setAttribute('aria-pressed', String(muted));
    button.setAttribute('aria-label', muted ? 'Unmute waiting sounds' : 'Mute waiting sounds');
    button.title = muted ? 'Waiting sounds muted' : 'Waiting sounds on';
    button.classList.toggle('muted', muted);
  }
  button.addEventListener('click', () => {
    muted = !muted;
    try { localStorage.setItem('keep-attention-muted', muted ? '1' : '0'); } catch {}
    render();
  });
  render();
  return {
    update(keys) {
      const count = keys.length;
      // Keep event identities across empty snapshots: a refresh, dismissal or
      // transient status change must not announce the same request again.
      const hasNew = keys.some((key) => !seen.has(key));
      for (const key of keys) seen.add(key);
      const shouldPlay = previous === 0 && count > 0 && hasNew && !muted;
      previous = count;
      if (shouldPlay && isDesktop()) void playAttentionSound();
    },
  };
}
