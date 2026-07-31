const mockListeners: Record<string, (value: boolean) => void> = {};
let mockInitialValue = false;
let mockAddCalls = 0;

jest.mock('react-native', () => ({
  AccessibilityInfo: {
    isReduceMotionEnabled: jest.fn(async () => mockInitialValue),
    addEventListener: jest.fn((event: string, handler: (value: boolean) => void) => {
      mockAddCalls += 1;
      mockListeners[event] = handler;
      return { remove: jest.fn() };
    }),
  },
}));

/* eslint-disable import/first */
import { AccessibilityInfo } from 'react-native';

import { __resetReducedMotionForTests, useReducedMotion } from '../src/lib/reduced-motion';
/* eslint-enable import/first */

/**
 * The store is exercised through its subscribe/getSnapshot pair rather than by
 * mounting a component: there is no react renderer in this project, and these
 * two functions are the entire contract `useSyncExternalStore` depends on.
 */
type Captured = {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => boolean;
};

function storeInternals(): Captured {
  const hook = useReducedMotion as unknown as () => boolean;
  // Held on an object rather than in a plain `let`: TypeScript cannot see the
  // assignment happen inside the interceptor, so a nullable local would narrow
  // to `never` by the time it is returned.
  const holder: { value?: Captured } = {};
  // Required, not imported: the module object has to be mutated in place to
  // intercept the hook call, and an ES import binding is read-only.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const react = require('react') as { useSyncExternalStore: unknown };
  const original = react.useSyncExternalStore;
  react.useSyncExternalStore = (
    subscribe: (l: () => void) => () => void,
    getSnapshot: () => boolean,
  ) => {
    holder.value = { subscribe, getSnapshot };
    return getSnapshot();
  };
  try {
    hook();
  } finally {
    react.useSyncExternalStore = original;
  }
  if (!holder.value) throw new Error('hook did not call useSyncExternalStore');
  return holder.value;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  __resetReducedMotionForTests();
  mockInitialValue = false;
  mockAddCalls = 0;
  for (const key of Object.keys(mockListeners)) delete mockListeners[key];
  jest.clearAllMocks();
});

describe('reduced motion store', () => {
  it('reports the setting the device starts with', async () => {
    mockInitialValue = true;
    const { subscribe, getSnapshot } = storeInternals();
    subscribe(() => undefined);
    await flush();

    expect(getSnapshot()).toBe(true);
  });

  it('follows a change made while the app is open', async () => {
    const { subscribe, getSnapshot } = storeInternals();
    const notified = jest.fn();
    subscribe(notified);
    await flush();
    expect(getSnapshot()).toBe(false);

    // A technician most often enables this *because* something on screen is
    // making them uncomfortable, so mid-session changes have to take effect.
    mockListeners.reduceMotionChanged?.(true);

    expect(getSnapshot()).toBe(true);
    expect(notified).toHaveBeenCalled();
  });

  it('subscribes to the platform once however many blocks are on screen', async () => {
    const { subscribe } = storeInternals();
    // A skeleton screen mounts a dozen independently animating blocks; each one
    // must not open its own AccessibilityInfo subscription.
    const unsubscribes = Array.from({ length: 12 }, () => subscribe(() => undefined));
    await flush();

    expect(mockAddCalls).toBe(1);
    expect(AccessibilityInfo.isReduceMotionEnabled).toHaveBeenCalledTimes(1);
    unsubscribes.forEach((unsubscribe) => unsubscribe());
  });

  it('returns a stable snapshot so React does not loop', () => {
    const { getSnapshot } = storeInternals();
    // useSyncExternalStore compares with Object.is and throws
    // "getSnapshot should be cached" if a fresh value comes back each call.
    expect(getSnapshot()).toBe(getSnapshot());
  });

  it('does not notify when the setting is re-reported unchanged', async () => {
    const { subscribe } = storeInternals();
    const notified = jest.fn();
    subscribe(notified);
    await flush();
    notified.mockClear();

    mockListeners.reduceMotionChanged?.(false);

    expect(notified).not.toHaveBeenCalled();
  });

  it('keeps animating if the platform cannot answer', async () => {
    (AccessibilityInfo.isReduceMotionEnabled as jest.Mock).mockRejectedValueOnce(
      new Error('unavailable'),
    );
    const { subscribe, getSnapshot } = storeInternals();
    subscribe(() => undefined);
    await flush();

    // Failing closed would silently freeze every loader and skeleton in the app.
    expect(getSnapshot()).toBe(false);
  });
});
