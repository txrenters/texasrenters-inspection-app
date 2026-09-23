import { homeSaveErrorMessage } from '../app/(app)/home-address';
import { ApiConnectionError } from '../src/storage/offline-record-cache';

const UNREACHABLE =
  'Could not reach the office right now. Your address was not changed — try again when you have signal.';

/**
 * The one line the home address screen shows when a save fails.
 *
 * Exercised as the function rather than through a renderer, matching the
 * convention in the other screen tests — the wording is the rule here, and
 * React's plumbing is not what gets it wrong.
 */
describe('homeSaveErrorMessage', () => {
  it('does not send a technician looking for signal when the office answered', () => {
    // A 500 is the app's own answer: the request arrived and came back, so the
    // radio was never in question. `ApiHomeRepository.set` writes without
    // `queueOnConnectionFailure`, so nothing upstream draws this distinction
    // for it — the message is the only place it can be drawn.
    const message = homeSaveErrorMessage(
      new ApiConnectionError('TexasRenters API request failed (500).', 'fault'),
    );
    expect(message).not.toMatch(/signal/i);
    expect(message).toContain('Nothing was changed');
  });

  it('keeps the signal wording for everything that never reached the office', () => {
    // 502/503/504 is the edge answering because it could not reach the app, and
    // a timeout cannot be shown to have arrived. Both are the outage the
    // original message was written for and both stay as they were.
    for (const reason of ['transport', 'timeout', 'unavailable'] as const) {
      expect(
        homeSaveErrorMessage(
          new ApiConnectionError('Cannot connect to the TexasRenters API.', reason),
        ),
      ).toBe(UNREACHABLE);
    }
  });

  it('shows the server its own words for an address it could not place', () => {
    // A 400 leaves `requestJson` as a plain Error carrying the API's message.
    // It is the one failure that really is about what was typed, and the reason
    // this function passes a message through verbatim at all.
    expect(homeSaveErrorMessage(new Error('That address could not be found precisely.'))).toBe(
      'That address could not be found precisely.',
    );
  });

  it('says something rather than nothing when there are no words to show', () => {
    expect(homeSaveErrorMessage(new Error(''))).toBe('Your address could not be saved.');
    expect(homeSaveErrorMessage('offline')).toBe('Your address could not be saved.');
  });
});
