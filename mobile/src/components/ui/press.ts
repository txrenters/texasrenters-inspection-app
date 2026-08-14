/**
 * The two press treatments this app uses, and nothing else.
 *
 * Seven were in circulation: `active:scale-[0.98]` (24 uses),
 * `active:scale-[0.95]` (6), `active:opacity-60` (6), `active:opacity-70` (5),
 * `active:scale-[0.97]` (4), `active:scale-[0.99]` (1) and
 * `active:opacity-80` (1). Nothing distinguished them — the 0.95 and the 0.99
 * sat on the same kind of control on adjacent screens — so a technician got a
 * slightly different response depending on which screen they were on.
 *
 * The split that survives is the one with a reason behind it:
 *
 * - **Discrete surfaces shrink.** A card, a button or a chip has visible edges,
 *   so scaling it reads as the whole object being pushed. This is the default.
 * - **Full-bleed rows dim.** A list row divided only by a hairline has no edge
 *   to shrink toward; scaling it drags the divider with it and the row appears
 *   to detach from the list. Opacity leaves the structure still.
 *
 * `PRESS_SURFACE` matches what 24 of the 42 call sites already did, so adopting
 * it changed almost nothing visually — it just made the choice explicit.
 */

/** Buttons, cards, chips, icon buttons — anything with its own visible edges. */
export const PRESS_SURFACE = 'active:scale-[0.98]';

/** Full-width list rows and inline text links, divided by hairlines or nothing. */
export const PRESS_ROW = 'active:opacity-60';
