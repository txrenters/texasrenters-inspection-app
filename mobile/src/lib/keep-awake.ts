import { useEffect } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

/**
 * Keeps the screen on while `active`, and shrugs when it cannot.
 *
 * Two screens need it. Navigation, so a phone in a windscreen cradle does not
 * dim mid-drive. And the camera while it records (2026-10-06): iOS Low Power
 * Mode forces Auto-Lock to thirty seconds, and a technician turning slowly
 * through a room touches nothing -- so the phone locked mid-walkthrough, the
 * camera session stopped, and the app went to the background with a take half
 * saved. Development builds keep the screen on by themselves, which is why
 * nobody testing ever saw it.
 *
 * Released on unmount and whenever the app leaves the foreground, because a lock
 * held by a screen nobody is looking at is a flat battery in a technician's
 * pocket. Each caller holds its own tag, so one releasing never drops another's.
 */
export function useKeepAwakeWhile(active: boolean, tag: string): void {
  useEffect(() => {
    if (!active) return;
    let held = false;
    let dropped = false;

    const activate = async () => {
      const module = await loadKeepAwake();
      if (!module || dropped || held) return;
      try {
        await module.activateKeepAwakeAsync?.(tag);
        held = true;
      } catch {
        // Not available on this build. Nothing to put back.
      }
    };

    const release = () => {
      if (!held) return;
      held = false;
      void loadKeepAwake().then((module) => {
        try {
          void module?.deactivateKeepAwake?.(tag);
        } catch {
          // Already gone, or never held.
        }
      });
    };

    void activate();

    const subscription = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'active') void activate();
      else release();
    });

    return () => {
      dropped = true;
      release();
      subscription.remove();
    };
  }, [active, tag]);
}

interface KeepAwakeModule {
  activateKeepAwakeAsync?: (tag?: string) => Promise<void>;
  deactivateKeepAwake?: (tag?: string) => void;
}

let keepAwakeModule: Promise<KeepAwakeModule | null> | null = null;

function loadKeepAwake(): Promise<KeepAwakeModule | null> {
  keepAwakeModule ??= (async () => {
    try {
      // A literal, and the reason is the exact opposite of what once stood
      // here. It was assembled at runtime (`['expo','keep','awake'].join('-')`)
      // on the theory that a specifier no bundler could resolve was the safe
      // choice. Metro does not treat that as a warning -- it refuses outright:
      //
      //   SyntaxError: Invalid call at line 391: import(name)
      //
      // which failed `expo export` and took the whole CI build down with it.
      // Jest never runs Metro, so every test passed and nothing local caught it.
      //
      // The literal is safe. `expo` itself declares `expo-keep-awake` as a
      // dependency, so it resolves here and is already autolinked into every
      // installed binary -- there is no runtime version to bump and no OTA that
      // can reach a build without it.
      //
      // The `try` stays, because the risk it guards is real and is at the call,
      // not the import: an Expo module whose native side is missing throws when
      // it is used. A phone that cannot hold the screen awake dims, which is a
      // poor experience and not a crash.
      return (await import('expo-keep-awake')) as KeepAwakeModule;
    } catch {
      return null;
    }
  })();
  return keepAwakeModule;
}
