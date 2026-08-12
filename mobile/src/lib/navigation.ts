import { router } from 'expo-router';

/** Where every screen falls back to when there is no stack to unwind. */
const HOME = '/(app)/(tabs)' as const;

/**
 * Goes back, or home when there is nowhere to go back to.
 *
 * `router.back()` dispatches GO_BACK, which is unhandled when the current screen
 * is the only entry in its stack — and that is not a rare case here. An
 * evidence-request notification opens straight into an area, deep links land
 * mid-hierarchy, and a Metro reload during development drops the technician onto
 * whatever route they were viewing. In all three the back arrow is drawn, tapping
 * it logs "The action 'GO_BACK' was not handled by any navigator", and nothing
 * moves.
 *
 * A back arrow that silently does nothing is worse than no arrow: it is the only
 * exit the screen offers, and a technician who taps it twice concludes the app
 * has frozen.
 */
export function goBack() {
  if (router.canGoBack()) {
    router.back();
    return;
  }
  // Replace, not push: home must not stack on top of the screen being left.
  router.replace(HOME);
}

/**
 * Leaves the whole signed-in stack for the tabs.
 *
 * Same guard as {@link goBack}, for POP_TO_TOP — `dismissAll` throws the action
 * at a navigator that may have nothing to dismiss.
 */
export function goHome() {
  if (router.canDismiss()) {
    router.dismissAll();
    return;
  }
  router.replace(HOME);
}
