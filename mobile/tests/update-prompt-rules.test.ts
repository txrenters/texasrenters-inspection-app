import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isSafeToInterrupt, shouldPromptForUpdate } from '../src/updates/update-prompt-rules';

describe('when an update prompt may interrupt', () => {
  it('stays out of the way on screens that hold unsaved work', () => {
    // A take in progress cannot be resumed, and one awaiting review has not
    // been saved yet. Both are worth more than a prompt arriving promptly.
    expect(isSafeToInterrupt('/(app)/camera/insp-1/area-1')).toBe(false);
    expect(isSafeToInterrupt('/(app)/recording-review/insp-1/area-1')).toBe(false);
  });

  it('is fine everywhere else', () => {
    expect(isSafeToInterrupt('/(app)/(tabs)')).toBe(true);
    expect(isSafeToInterrupt('/(app)/areas/area-1')).toBe(true);
    expect(isSafeToInterrupt('/(app)/inspections/insp-1')).toBe(true);
  });

  it('is fine on the screens reached without a session', () => {
    // The prompt is mounted at the root rather than inside `(app)`, so these
    // are now reachable paths for it. A technician who cannot sign in is
    // exactly who a fix is usually for, and gating the update behind signing
    // in meant a build with a broken API address could never repair itself.
    expect(isSafeToInterrupt('/login')).toBe(true);
    expect(isSafeToInterrupt('/forgot-password')).toBe(true);
    expect(isSafeToInterrupt('/change-password')).toBe(true);
    expect(isSafeToInterrupt('/')).toBe(true);
  });
});

describe('where the update prompt is mounted', () => {
  /**
   * Asserted against the layout source, because this is a placement rule that
   * no unit test of the component can see. It was mounted inside the
   * authenticated group, so nothing checked for an update, downloaded one, or
   * offered the restart that applies it until somebody had signed in.
   */
  const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

  it('sits at the root, above the auth gate', () => {
    expect(read('app/_layout.tsx')).toContain('<UpdatePrompt />');
  });

  it('is not gated behind the signed-in area', () => {
    // `(app)/_layout.tsx` returns <Redirect href="/login" /> before it renders
    // anything, so a prompt in there can never reach a signed-out technician.
    expect(read('app/(app)/_layout.tsx')).not.toContain('<UpdatePrompt />');
  });
});

describe('whether to show the update prompt', () => {
  const base = { dismissed: false, isUpdatePending: true, pathname: '/(app)/(tabs)' };

  it('shows once an update is downloaded and waiting', () => {
    expect(shouldPromptForUpdate(base)).toBe(true);
  });

  it('says nothing about an update that has not finished downloading', () => {
    // Offering to restart into an update that is not on the device yet would
    // restart into the same build.
    expect(shouldPromptForUpdate({ ...base, isUpdatePending: false })).toBe(false);
  });

  it('stays dismissed after Later, rather than returning on every navigation', () => {
    expect(shouldPromptForUpdate({ ...base, dismissed: true })).toBe(false);
  });

  it('waits while a recording is on screen', () => {
    expect(shouldPromptForUpdate({ ...base, pathname: '/(app)/camera/insp-1/area-1' })).toBe(false);
  });
});
