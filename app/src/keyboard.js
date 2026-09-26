// Where the keyboard's top edge is, and where a view's bottom edge is, for
// keyboardPadding (src/keyboard-padding.js), which keeps the bottom of every screen
// above the keyboard. Android only: iOS screens that type use their own
// KeyboardAvoidingView, and padding here as well would reserve the keyboard twice.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, Platform } from 'react-native';

// The keyboard's top while it is open, or null. RN reports it in screen coordinates and
// the frame is measured in window coordinates; they agree for a full-screen app and the
// upper pane of split screen. In the lower pane the window's own offset is not
// available to JS, the overlap comes out short, and inputs there can still sit under
// the keyboard (a known limit; a native inset listener would fix it).
export function useKeyboardTop() {
  const [top, setTop] = useState(null);
  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const show = Keyboard.addListener('keyboardDidShow', (event) => {
      const y = Number(event?.endCoordinates?.screenY);
      setTop(Number.isFinite(y) ? y : null);
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => setTop(null));
    return () => { show.remove(); hide.remove(); };
  }, []);
  return top;
}

// A view's bottom edge in window coordinates, re-measured on every layout and whenever
// the keyboard moves (a resize can land before or after the keyboard event). Returns
// the ref to put on the view, its onLayout, and the measured bottom.
export function useViewBottom(keyboardTop) {
  const ref = useRef(null);
  const [bottom, setBottom] = useState(null);
  const measure = useCallback(() => {
    ref.current?.measureInWindow?.((x, y, width, height) => {
      const next = y + height;
      if (Number.isFinite(next)) setBottom((current) => (current === next ? current : next));
    });
  }, []);
  useEffect(() => { measure(); }, [keyboardTop, measure]);
  return { ref, onLayout: measure, bottom };
}
