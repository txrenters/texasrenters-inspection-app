import { reportFatalNow } from '../src/lib/error-log';
import { unexpectedExit, type SessionBreadcrumb } from '../src/lib/session-breadcrumb';
import { demoStorageNow } from '../src/storage/demo-storage';

/**
 * Seeing the crashes the Error log could not (2026-10-06).
 *
 * iPhones froze and closed during move-outs, and nothing reached the log: iOS
 * ending an app for memory runs no JavaScript at all, and a fatal JS error's
 * entry was written asynchronously, after the process was already gone.
 */

const crumb = (patch: Partial<SessionBreadcrumb>): SessionBreadcrumb => ({
  startedAt: '2026-10-06T14:00:00.000Z',
  at: '2026-10-06T14:42:00.000Z',
  state: 'active',
  activity: 'idle',
  ...patch,
});

describe('how the previous session ended', () => {
  it('is a crash when the app was on screen', () => {
    const exit = unexpectedExit(crumb({ activity: 'recording' }));
    expect(exit).toMatchObject({ fatal: true });
    expect(exit?.message).toMatch(/while a room was being filmed/);
    expect(exit?.message).toMatch(/42 min into the session/);
  });

  it('is worth a note in the background only mid-take or mid-upload', () => {
    expect(unexpectedExit(crumb({ state: 'background', activity: 'uploading' }))).toMatchObject({
      fatal: false,
    });
    // An idle app reclaimed in a pocket, or swiped away: ordinary.
    expect(unexpectedExit(crumb({ state: 'background', activity: 'idle' }))).toBeNull();
  });

  it('is nothing when the app restarted itself into an update', () => {
    expect(unexpectedExit(crumb({ state: 'restarting' }))).toBeNull();
  });

  it('is nothing on a first launch', () => {
    expect(unexpectedExit(null)).toBeNull();
  });
});

describe('a fatal error', () => {
  it('is on disk before the call returns', () => {
    reportFatalNow(new Error('Maximum call stack size exceeded'));

    const stored = JSON.parse(demoStorageNow.getItem('texasrenters-inspection-error-log-v1') ?? '[]') as {
      message: string;
      fatal: boolean;
    }[];
    expect(stored[0]).toMatchObject({ message: 'Maximum call stack size exceeded', fatal: true });
  });
});
