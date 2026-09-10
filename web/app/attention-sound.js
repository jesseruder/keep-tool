import { isDesktop, playAttentionSound } from './shell.js';

// Follow the displayed queue, including local dismissals, without sounding on boot.
export function installAttentionSound() {
  const button = document.querySelector('#soundButton');
  let previous;
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
    update(count) {
      const shouldPlay = previous === 0 && count > 0 && !muted;
      previous = count;
      if (shouldPlay && isDesktop()) void playAttentionSound();
    },
  };
}
