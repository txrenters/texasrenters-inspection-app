import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(cleanup);

// jsdom has no ResizeObserver. This stub invokes the callback synchronously on
// observe so a test can read a stubbed clientWidth/Height deterministically.
class ResizeObserverStub {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver =
  globalThis.ResizeObserver ?? (ResizeObserverStub as unknown as typeof ResizeObserver);

// Server-side suites opt into `@vitest-environment node`, where none of the DOM
// polyfills below apply — and referencing MouseEvent there is a hard error.
const hasDom = typeof globalThis.MouseEvent !== 'undefined';

// jsdom implements MouseEvent but not PointerEvent, so pointer events dispatched
// in tests would silently drop clientX/clientY. Extending MouseEvent keeps the
// real browser's coordinate behaviour for drag/placement tests.
if (hasDom && typeof globalThis.PointerEvent === 'undefined') {
  class PointerEventStub extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    constructor(type: string, params: PointerEventInit = {}) {
      super(type, params);
      this.pointerId = params.pointerId ?? 1;
      this.pointerType = params.pointerType ?? 'mouse';
    }
  }
  globalThis.PointerEvent = PointerEventStub as unknown as typeof PointerEvent;
}

// Pointer capture is unimplemented in jsdom; no-ops keep drag handlers working.
if (hasDom && typeof Element.prototype.setPointerCapture === 'undefined') {
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.hasPointerCapture = () => false;
}
