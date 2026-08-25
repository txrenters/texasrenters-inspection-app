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
