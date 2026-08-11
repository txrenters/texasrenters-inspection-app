import { describe, expect, it } from 'vitest';

import {
  centerOnMarker,
  clamp01,
  clientToNormalized,
  computeContainRect,
  fitBoundingBox,
  markerToBase,
  nudgeStep,
} from './floor-plan-geometry';

// A 2000×1000 image inside an 800×800 stage: contain scale 0.4 → 800×400
// rendered, letterboxed with 200px bands top and bottom.
const rect = computeContainRect(2000, 1000, 800, 800)!;

describe('floor-plan geometry', () => {
  it('computes the contained rect with letterboxing', () => {
    expect(rect).toEqual({ scale: 0.4, renderedW: 800, renderedH: 400, offsetX: 0, offsetY: 200 });
  });

  it('returns null before the image/container have size', () => {
    expect(computeContainRect(0, 0, 800, 800)).toBeNull();
    expect(computeContainRect(2000, 1000, 0, 0)).toBeNull();
  });

  it('maps a normalized centre to base pixels', () => {
    expect(markerToBase(rect, 0.5, 0.5)).toEqual({ left: 400, top: 400 });
    expect(markerToBase(rect, 0, 0)).toEqual({ left: 0, top: 200 });
  });

  it('inverse-maps a click to normalized at zoom 1', () => {
    const marker = clientToNormalized(400, 400, { left: 0, top: 0 }, { zoom: 1, pan: { x: 0, y: 0 } }, rect)!;
    expect(marker.x).toBeCloseTo(0.5);
    expect(marker.y).toBeCloseTo(0.5);
  });

  it('inverse-maps correctly under zoom + pan (round trip)', () => {
    // marker 0.5,0.5 → base 400,400 → screen at zoom 2, pan(-400,-400): 2*400-400 = 400
    const marker = clientToNormalized(400, 400, { left: 0, top: 0 }, { zoom: 2, pan: { x: -400, y: -400 } }, rect)!;
    expect(marker.x).toBeCloseTo(0.5);
    expect(marker.y).toBeCloseTo(0.5);
  });

  it('round-trips forward→inverse across random zoom/pan', () => {
    for (const [x, y, zoom, panx, pany] of [
      [0.1, 0.9, 1, 0, 0],
      [0.5, 0.5, 3, -120, 40],
      [0.8, 0.2, 2.5, 200, -80],
    ]) {
      const base = markerToBase(rect, x, y);
      const screenX = panx + zoom * base.left;
      const screenY = pany + zoom * base.top;
      const back = clientToNormalized(screenX, screenY, { left: 0, top: 0 }, { zoom, pan: { x: panx, y: pany } }, rect)!;
      expect(back.x).toBeCloseTo(x);
      expect(back.y).toBeCloseTo(y);
    }
  });

  it('maps a click in the top letterbox band to y<0 (Place ignores it)', () => {
    const marker = clientToNormalized(400, 50, { left: 0, top: 0 }, { zoom: 1, pan: { x: 0, y: 0 } }, rect)!;
    expect(marker.y).toBeLessThan(0);
  });

  it('clamps normalized values', () => {
    expect(clamp01(1.4)).toBe(1);
    expect(clamp01(-0.2)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
  });

  it('centres a marker at the stage middle keeping zoom', () => {
    // base 400,400; zoom 2 → pan = 400 - 2*400 = -400
    expect(centerOnMarker(rect, { x: 0.5, y: 0.5 }, 800, 800, 2)).toEqual({ x: -400, y: -400 });
  });

  it('fits a bounding box within zoom limits', () => {
    const transform = fitBoundingBox(rect, { x: 0.4, y: 0.4, width: 0.2, height: 0.2 }, 800, 800, 0);
    expect(transform.zoom).toBeGreaterThan(1);
    expect(transform.zoom).toBeLessThanOrEqual(6);
  });

  it('scales the keyboard nudge step by zoom', () => {
    expect(nudgeStep(rect, 1, 1)).toBeCloseTo(1 / 800);
    expect(nudgeStep(rect, 2, 1)).toBeCloseTo(1 / 1600);
  });
});
