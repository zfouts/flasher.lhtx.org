/**
 * Which wizard step the current state can honor, and how steps map to URLs.
 *
 * This is the safety interlock in front of writing firmware, so it lives
 * apart from the DOM and stays pure: `reachable()` is handed the state rather
 * than reading it, which is what lets test/steps.test.mjs drive every case,
 * including the ones that are awkward to reach by hand in a browser.
 *
 * The rule that matters: a step opens only on state that is still true *now*.
 * A verified download stops counting the moment the choice it was made for
 * changes, because history navigation can return to the flash step long after
 * the board, role, version or install mode moved on underneath it.
 */

export const STEP = { radio: 1, firmware: 2, flash: 3, connect: 4, configure: 5, done: 6 };

/* Every step is addressable, so the back button works and a step can be
   linked to. Only `radio` and `connect` mean anything on a cold load: the
   rest need a chosen board, a verified download or a connected radio, and
   `nearestReachable()` sends you to the furthest step your state actually
   supports rather than showing an empty screen. */
export const SLUG = { radio: 'radio', firmware: 'firmware', flash: 'flash', connect: 'connect', configure: 'configure', done: 'done' };
export const STEP_BY_SLUG = Object.fromEntries(Object.entries(STEP).map(([k, n]) => [SLUG[k], n]));
export const SLUG_BY_STEP = Object.fromEntries(Object.entries(STEP).map(([k, n]) => [n, SLUG[k]]));

/**
 * True when the download in hand is verified *and* is still the file the
 * current selection asks for. `pickAsset()` builds a fresh object every time
 * the choice changes, so identity is exactly the question "is this the same
 * decision the user reviewed?" — and `asset` being null after a change means
 * a stale download can never answer yes.
 */
export function downloadIsCurrent(state) {
  return Boolean(state.download?.verdict?.ok && state.asset && state.download.asset === state.asset);
}

export function reachable(state, step) {
  switch (step) {
    case STEP.radio:
    case STEP.connect:
      return true;                              // both are valid entry points
    case STEP.firmware:
      return Boolean(state.board && state.roleKey && state.asset);
    case STEP.flash:
      return downloadIsCurrent(state);
    case STEP.configure:
      return Boolean(state.client);
    case STEP.done:
      return Boolean(state.configured);
    default:
      return false;
  }
}

/** The furthest step we can honor, walking back from the one asked for. */
export function nearestReachable(state, step) {
  for (let n = step; n >= STEP.radio; n -= 1) if (reachable(state, n)) return n;
  return STEP.radio;
}
