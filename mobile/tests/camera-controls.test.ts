import { cameraZoomFor, pickBackLenses, pinchLevel } from '../src/capture/camera-zoom';
import { primaryCapture } from '../src/capture/capture-intents';
import { iconRotationFor } from '../src/capture/icon-rotation';

/**
 * The capture screen, as asked for from the field on 11 September:
 * the controls should turn when the phone does, zoom should reach the 0.5x
 * lens, and on an occupied visit the big red button should take photographs.
 */

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

describe('which capture gets the big red button', () => {
  it('always records first on a visit that has to be filmed', () => {
    expect(primaryCapture(true, undefined)).toBe('VIDEO');
    expect(primaryCapture(true, 'PHOTO')).toBe('VIDEO');
  });

  it('photographs first on an occupied visit unless the technician chose video', () => {
    expect(primaryCapture(false, undefined)).toBe('PHOTO');
    expect(primaryCapture(false, 'PHOTO')).toBe('PHOTO');
    expect(primaryCapture(false, 'VIDEO')).toBe('VIDEO');
  });
});
