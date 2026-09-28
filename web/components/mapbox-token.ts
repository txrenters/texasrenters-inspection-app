/**
 * The token every map in this console draws with, and what is wrong with it.
 *
 * Public by design, like every `pk.` token: it ships inside the JavaScript
 * bundle and anyone reading the page can see it. Mapbox's answer to that is a
 * URL restriction on the token, not secrecy — so restrict it to this console's
 * hosts rather than trying to hide it.
 *
 * Inlined at build time like every `NEXT_PUBLIC_*` value, so it is a property
 * of the image rather than something a restart or an `ssh` can change.
 */

export const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? '';

/**
 * What is wrong with a Mapbox token, in a sentence, or null when it is usable.
 *
 * **The `sk.` case is the reason this exists.** A secret token was once put in
 * `NEXT_PUBLIC_MAPBOX_TOKEN`, and it failed twice over: Mapbox GL refuses a
 * non-`pk.` token in a browser, so every map drew as an empty rectangle, *and*
 * the secret was compiled into a public bundle and served to everyone who
 * loaded the console. It cost a revoked key and a rebuild.
 *
 * Nothing about that was visible from the outside. The build passed, the
 * workflow log showed the value had been handed over — masked as `***`, which
 * says non-empty and nothing else — and the map simply did not appear. So the
 * check is here, said out loud, rather than left to be worked out from a blank
 * map a second time.
 */
export function mapboxTokenProblem(token: string): string | null {
  if (!token.trim()) return 'The map needs a Mapbox token (NEXT_PUBLIC_MAPBOX_TOKEN).';
  if (token.startsWith('sk.'))
    return 'That is a Mapbox secret token. A browser is only allowed a public one, which starts with pk. — and a secret token placed here is published to everyone who loads this page, so revoke it and build again with the pk. token.';
  if (!token.startsWith('pk.'))
    return 'That does not look like a Mapbox public token; they start with pk.';
  return null;
}
