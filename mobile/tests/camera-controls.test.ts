import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cameraZoomFor, pickBackLenses, pinchLevel } from '../src/capture/camera-zoom';
import { RECORDING_RED, captureControlLook } from '../src/capture/capture-controls';
import { asksCaptureChoice, primaryCapture } from '../src/capture/capture-intents';
import { iconRotationFor } from '../src/capture/icon-rotation';

/**
 * The capture screen, as asked for from the field on 11 September:
 * the controls should turn when the phone does, zoom should reach the 0.5x
 * lens, and on an occupied visit the big button should take photographs.
 *
 * And as the product owner asked when that was demoed: photos or video chosen
 * for each area rather than once per inspection, a shutter that is not red, and
 * no checklist on the camera.
 */

const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');
const CAMERA_SCREEN = 'app/(app)/camera/[inspectionId]/[areaId].tsx';

describe('turning the controls with the phone', () => {
  it('keeps them upright in portrait', () => {
    expect(iconRotationFor({ x: 0, y: -1 }, 'ios', 0)).toBe(0);
  });

  it('turns them clockwise when the phone is turned anticlockwise, and back', () => {
    // Left edge down: iOS reads gravity along -x.
    expect(iconRotationFor({ x: -1, y: 0 }, 'ios', 0)).toBe(90);
    expect(iconRotationFor({ x: 1, y: 0 }, 'ios', 0)).toBe(-90);
  });

  it('reads Android the other way round, since it reports the opposite sign', () => {
    // The same two poses on an Android phone.
    expect(iconRotationFor({ x: 1, y: 0 }, 'android', 0)).toBe(90);
    expect(iconRotationFor({ x: 0, y: 1 }, 'android', 90)).toBe(0);
  });

  it('holds its place for a phone halfway between, so the icons do not flicker', () => {
    const diagonal = { x: -0.7, y: -0.7 };
    expect(iconRotationFor(diagonal, 'ios', 0)).toBe(0);
    expect(iconRotationFor(diagonal, 'ios', 90)).toBe(90);
  });

  it('ignores a phone lying flat, which says nothing about which way is up', () => {
    expect(iconRotationFor({ x: 0.05, y: -0.1 }, 'ios', -90)).toBe(-90);
  });

  it('does not spin the controls for a phone held upside down', () => {
    expect(iconRotationFor({ x: 0, y: 1 }, 'ios', 0)).toBe(0);
  });
});

describe('the lenses behind the zoom chips', () => {
  it('finds the wide and ultra-wide lenses by the names iOS gives them', () => {
    const names = [
      'Back Camera',
      'Back Dual Wide Camera',
      'Back Telephoto Camera',
      'Back Triple Camera',
      'Back Ultra Wide Camera',
    ];
    expect(pickBackLenses(names)).toEqual({
      main: 'Back Camera',
      ultraWide: 'Back Ultra Wide Camera',
    });
  });

  it('offers no 0.5x on a phone without an ultra-wide, rather than a virtual camera in its place', () => {
    expect(pickBackLenses(['Back Camera', 'Back Dual Wide Camera'])).toEqual({
      main: 'Back Camera',
      ultraWide: undefined,
    });
  });

  it('matches nothing when the names are in another language', () => {
    expect(pickBackLenses(['Cámara trasera', 'Cámara ultra gran angular'])).toEqual({
      main: undefined,
      ultraWide: undefined,
    });
  });
});

describe('pinch to zoom', () => {
  it('starts at no zoom on both platforms', () => {
    expect(cameraZoomFor(0, 'ios')).toBe(0);
    expect(cameraZoomFor(0, 'android')).toBe(0);
  });

  it('keeps a full pinch to a modest zoom rather than the lens maximum', () => {
    expect(cameraZoomFor(1, 'ios')).toBeCloseTo(0.3);
    expect(cameraZoomFor(1, 'android')).toBeCloseTo(0.3);
  });

  it('skips the part of Android zoom that is clamped to 1x, so a pinch responds at once', () => {
    expect(cameraZoomFor(0.01, 'android')).toBeGreaterThanOrEqual(0.1);
  });

  it('carries on from where the last pinch left off', () => {
    expect(pinchLevel(0.4, 1.25)).toBeCloseTo(0.65);
    expect(pinchLevel(0.4, 0.5)).toBe(0);
    expect(pinchLevel(0.9, 3)).toBe(1);
  });

  it('ignores a pinch it cannot measure', () => {
    expect(pinchLevel(0.4, 0)).toBe(0.4);
    expect(pinchLevel(0.4, Number.NaN)).toBe(0.4);
  });
});

describe('which capture gets the big button', () => {
  it('always records first on a visit that has to be filmed', () => {
    expect(primaryCapture(true, undefined)).toBe('VIDEO');
    expect(primaryCapture(true, 'PHOTO')).toBe('VIDEO');
  });

  it('photographs first on an occupied area unless the technician chose video for it', () => {
    expect(primaryCapture(false, undefined)).toBe('PHOTO');
    expect(primaryCapture(false, 'PHOTO')).toBe('PHOTO');
    expect(primaryCapture(false, 'VIDEO')).toBe('VIDEO');
  });

  it('reads the answer given for the area on screen, not one for the whole inspection', () => {
    expect(read(CAMERA_SCREEN)).toContain('state.captureModeByArea[areaId]');
  });
});

describe('whether opening the camera on an area asks photos or video first', () => {
  const unanswered = {
    requiresRecording: false,
    chosen: undefined,
    additionalClip: false,
  } as const;

  it('asks on an occupied area that has no answer yet', () => {
    expect(asksCaptureChoice(unanswered)).toBe(true);
  });

  it('does not ask again once the area has an answer, whichever it was', () => {
    // Reopening the camera on the same room goes straight in.
    expect(asksCaptureChoice({ ...unanswered, chosen: 'PHOTO' })).toBe(false);
    expect(asksCaptureChoice({ ...unanswered, chosen: 'VIDEO' })).toBe(false);
  });

  it('never asks on a visit that has to be filmed, so its walkthrough stays first', () => {
    // A move-in or move-out owes one walkthrough per approved room. Offering
    // photographs there would be offering a way around that.
    expect(asksCaptureChoice({ ...unanswered, requiresRecording: true })).toBe(false);
    expect(asksCaptureChoice({ ...unanswered, requiresRecording: true, chosen: 'PHOTO' })).toBe(
      false,
    );
  });

  it('does not ask on the way to an additional clip, whose button already said video', () => {
    expect(asksCaptureChoice({ ...unanswered, additionalClip: true })).toBe(false);
  });

  it('is asked on the area screen, and no longer when the inspection is started', () => {
    expect(read('app/(app)/areas/[id].tsx')).toContain('<CaptureChoiceSheet');
    expect(read('app/(app)/inspections/[id].tsx')).not.toMatch(/setCaptureMode|CaptureChoiceSheet/);
  });
});

describe('how the capture controls are drawn', () => {
  const classesOf = (look: ReturnType<typeof captureControlLook>) =>
    [look.ring, look.disc ?? '', look.glyph ?? ''].join(' ');

  it('draws the big shutter as a white ring around a white disc, with no red in it', () => {
    const look = captureControlLook({ large: true, stopControl: false });
    expect(look.ring).toContain('border-white');
    expect(look.disc).toContain('bg-white');
    expect(classesOf(look)).not.toMatch(/red/);
  });

  it('keeps the small control a neutral outline', () => {
    expect(classesOf(captureControlLook({ large: false, stopControl: false }))).not.toMatch(/red/);
  });

  it('turns red only as the stop control of a take that is running', () => {
    for (const large of [true, false]) {
      const look = captureControlLook({ large, stopControl: true });
      expect(look.disc).toContain(RECORDING_RED);
      // A plain stop square: nothing drawn over it.
      expect(look.glyph).toBeNull();
    }
  });

  it('does not change the ring when a take starts, only what is inside it', () => {
    // The control a thumb is resting on must not move or resize mid-recording.
    for (const large of [true, false]) {
      expect(captureControlLook({ large, stopControl: true }).ring).toBe(
        captureControlLook({ large, stopControl: false }).ring,
      );
    }
  });

  it('leaves no red of its own on the camera screen controls', () => {
    // Every red on the controls comes from `captureControlLook`. The screen's
    // error banner is red on purpose and uses different shades.
    expect(read(CAMERA_SCREEN)).not.toContain('bg-red-500');
  });
});

describe('where the checklist lives', () => {
  const camera = read(CAMERA_SCREEN);
  const area = read('app/(app)/areas/[id].tsx');

  it('is not on the camera screen, as a prompt or as a sheet', () => {
    expect(camera).not.toMatch(/<ConditionPromptSheet|<AreaChecklistSheet/);
    expect(camera).not.toMatch(/from '@\/src\/capture\/(ConditionPromptSheet|AreaChecklistSheet)'/);
    expect(existsSync(join(__dirname, '..', 'src/capture/ConditionPromptSheet.tsx'))).toBe(false);
  });

  it('is on the area screen, where the camera’s Done still lands on the questions', () => {
    expect(area).toContain('<OccupiedConditionCard');
    expect(area).toContain('<AreaChecklistSheet');
    expect(camera).toContain("params: { id: areaId, focus: 'condition' }");
  });
});
