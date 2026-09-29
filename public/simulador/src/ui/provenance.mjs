/**
 * Where the words in a box came from.
 *
 * Not a lie detector and not an accusation. A pasted paragraph and a typed one
 * are different events, and knowing which is which is the difference between
 * "answered in place" and "answered somewhere else and brought back" — both of
 * which are legitimate, and only one of which you can ask about if you cannot
 * see it.
 *
 * Scope, and it is deliberately narrow: only this app's own inputs, only while
 * they are focused. Nothing reads the clipboard, the page, the screen or any
 * other tab. What it captures is timing and length — never content from
 * anywhere the player did not type or paste it themselves.
 *
 * This is disclosed in the app before anyone plays. If it ever needs hiding to
 * work, it is the wrong instrument.
 */
function watchInput(el) {
  const state = { keystrokes: 0, gaps: [], pastes: 0, pastedChars: 0, lastKey: 0, firstAt: 0, corrections: 0 };

  el.addEventListener('keydown', (ev) => {
    const now = performance.now();
    if (!state.firstAt) state.firstAt = now;
    if (ev.key === 'Backspace' || ev.key === 'Delete') state.corrections++;
    if (ev.key.length === 1) {
      state.keystrokes++;
      if (state.lastKey) state.gaps.push(now - state.lastKey);
      state.lastKey = now;
    }
  });

  el.addEventListener('paste', (ev) => {
    state.pastes++;
    const text = ev.clipboardData?.getData('text') || '';
    // Length only. The content is whatever they chose to put in the box, and it
    // gets recorded as the answer anyway — there is nothing extra to take.
    state.pastedChars += text.length;
  });

  return {
    /** Summary for one submitted field, then reset for the next one. */
    take(value = '') {
      const chars = String(value).length;
      const gaps = state.gaps.slice().sort((a, b) => a - b);
      const median = gaps.length ? Math.round(gaps[Math.floor(gaps.length / 2)]) : null;
      const out = {
        chars,
        typed: state.keystrokes,
        pastes: state.pastes,
        pasted_chars: state.pastedChars,
        /** Most of it arrived without anyone typing it. */
        mostly_pasted: chars > 0 && state.pastedChars / chars > 0.6,
        /** Text with no keystrokes and no paste behind it: filled in by something
         *  other than a person at a keyboard. */
        appeared: chars > 0 && state.keystrokes === 0 && state.pastes === 0,
        median_gap_ms: median,
        corrections: state.corrections,
        compose_ms: state.firstAt ? Math.round(performance.now() - state.firstAt) : null,
      };
      Object.assign(state, { keystrokes: 0, gaps: [], pastes: 0, pastedChars: 0, lastKey: 0, firstAt: 0, corrections: 0 });
      return out;
    },
  };
}

export { watchInput };

