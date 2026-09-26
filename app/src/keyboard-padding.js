// The padding a screen needs at its bottom edge so nothing sits under the software
// keyboard: at least the safe-area inset (the gesture bar), and with the keyboard open,
// however far the screen's own bottom edge reaches below the keyboard's top.
//
// Android 15 draws apps edge to edge and no longer shrinks the window for the keyboard,
// so the app has to make that room itself. Measuring the overlap directly (the frame's
// bottom in window coordinates against the keyboard's top from keyboardDidShow) needs no
// bookkeeping of window heights: where the system does still shrink the window, or the
// app sits in split screen, the frame's bottom already ends above the keyboard and
// nothing extra is added, whatever order the resize and the keyboard event arrive in.
// Android only: iOS screens that type use their own KeyboardAvoidingView.
function keyboardPadding({ insetBottom = 0, frameBottom = null, keyboardTop = null } = {}) {
  const inset = Math.max(0, Number(insetBottom) || 0);
  const bottom = Number(frameBottom);
  const top = Number(keyboardTop);
  if (frameBottom == null || keyboardTop == null || !Number.isFinite(bottom) || !Number.isFinite(top)) return inset;
  return Math.max(inset, bottom - top);
}

module.exports = { keyboardPadding };
