# Over-the-air updates

Most changes reach technicians without a new build. Some cannot, and the
difference is not a judgement call — it is decided by whether the change alters
anything native.

```bash
npm run update --workspace @texasrenters/mobile -- --message "what changed"
```

That publishes the current JavaScript bundle to the `production` channel. Apps
pick it up on next launch.

## What an update can and cannot carry

An update ships the JavaScript bundle and assets. It cannot ship native code,
because the native binary is already installed on the device.

| Change | Reaches the field by |
| --- | --- |
| Screens, hooks, logic, styling, copy | Update |
| Images, fonts, other bundled assets | Update |
| A new dependency that is pure JavaScript | Update |
| **A new native module** (`expo-blur`, `expo-camera`, anything with an Android/iOS side) | **Build** |
| **Anything in `app.config.ts` plugins, permissions, icons, splash** | **Build** |
| **A change to `version`** | **Build** — and see the warning below |
| Expo SDK upgrade | Build |

`expo-blur` is the worked example. It was added after the 1.0.0 APK was built,
so that APK cannot run the current bundle no matter how the update is published:
the JavaScript would import a native module the binary does not contain.

## The runtime version is the whole mechanism

`app.config.ts` sets `runtimeVersion: { policy: 'appVersion' }`, so the runtime
version *is* `version` — currently `1.0.0`. An update only reaches installs
whose runtime version matches exactly.

**Bumping `version` orphans every existing install.** Change it to `1.0.1` and
the update goes to a runtime called `1.0.1` that nobody is running; every phone
in the field stays on the last `1.0.0` bundle and silently stops receiving
fixes. That is correct behaviour — a build with different native code must not
be handed a bundle built for another one — but it is easy to do by accident.

So: bump `version` only when you are shipping a new build to go with it, and
ship that build to every device before relying on updates again.

## Checking what is out there

```bash
npm run update:check --workspace @texasrenters/mobile
```

Lists the recent updates on the `production` branch — what was published, when,
and against which runtime version. If a fix is not reaching the field, compare
the runtime version there against the one in the installed build; a mismatch is
almost always the answer.

## Rolling one back

Republish the previous commit rather than deleting anything:

```bash
git checkout <good-commit> -- ../mobile
npm run update --workspace @texasrenters/mobile -- --message "revert to <good-commit>"
```

An update is additive; devices take the newest one for their runtime. There is
no undo, only a newer publish.
