import { useDemoStore } from '../src/stores/demo.store';

/**
 * Photos or video, remembered per area on the handset.
 *
 * It was one answer per inspection, given at "Start inspection". The product
 * owner asked for it per area, because the answer depends on the room. The
 * store is persisted without a version, so the new key has to arrive by the
 * default shallow merge -- a version without a `migrate` would throw away every
 * recording and upload waiting on the device.
 */

const storage = () => {
  const options = useDemoStore.persist.getOptions();
  if (!options.storage || !options.name) throw new Error('The demo store is not persisted');
  return { storage: options.storage, name: options.name };
};

describe('the photos-or-video answer for an area', () => {
  beforeEach(() => {
    useDemoStore.setState({ captureModeByArea: {} });
  });

  it('is remembered for the area it was given for, and no other', () => {
    useDemoStore.getState().setCaptureMode('kitchen', 'VIDEO');
    useDemoStore.getState().setCaptureMode('bedroom-2', 'PHOTO');

    expect(useDemoStore.getState().captureModeByArea).toEqual({
      kitchen: 'VIDEO',
      'bedroom-2': 'PHOTO',
    });
    expect(useDemoStore.getState().captureModeByArea['main-bathroom']).toBeUndefined();
  });

  it('can be changed without touching the other areas', () => {
    const { setCaptureMode } = useDemoStore.getState();
    setCaptureMode('kitchen', 'PHOTO');
    setCaptureMode('bedroom-2', 'PHOTO');
    setCaptureMode('kitchen', 'VIDEO');

    expect(useDemoStore.getState().captureModeByArea).toEqual({
      kitchen: 'VIDEO',
      'bedroom-2': 'PHOTO',
    });
  });

  it('is written to storage with the rest of the device state', async () => {
    useDemoStore.getState().setCaptureMode('kitchen', 'VIDEO');

    const { storage: persisted, name } = storage();
    const stored = (await persisted.getItem(name)) as {
      state: Record<string, unknown>;
    } | null;
    expect(stored?.state.captureModeByArea).toEqual({ kitchen: 'VIDEO' });
    // The per-inspection answer it replaced is no longer written at all.
    expect(stored?.state).not.toHaveProperty('captureModeByInspection');
  });

  it('upgrades a handset that saved the per-inspection answer without losing its evidence', async () => {
    const { storage: persisted, name } = storage();
    // What the previous build wrote: no per-area key, the old per-inspection
    // one, and work on the device that must survive the update.
    await persisted.setItem(name, {
      state: {
        selectedUserId: 'tech-1',
        media: [{ id: 'local-media-1', roomId: 'kitchen', inspectionId: 'insp-1' }],
        areaChecklist: { kitchen: ['Sink and taps'] },
        captureModeByInspection: { 'insp-1': 'VIDEO' },
      },
      version: 0,
    } as never);

    await useDemoStore.persist.rehydrate();

    const state = useDemoStore.getState();
    expect(state.selectedUserId).toBe('tech-1');
    expect(state.media.map((item) => item.id)).toEqual(['local-media-1']);
    expect(state.areaChecklist).toEqual({ kitchen: ['Sink and taps'] });
    // Nothing carries over from the whole-inspection answer: each area of that
    // inspection is simply asked when its camera is first opened.
    expect(state.captureModeByArea).toEqual({});
    expect(state.captureModeByArea.kitchen).toBeUndefined();
  });
});
