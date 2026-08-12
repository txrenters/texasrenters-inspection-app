import { cssInterop } from 'nativewind';
import { SafeAreaView } from 'react-native-safe-area-context';

/**
 * Teaches NativeWind about third-party components we style with `className`.
 *
 * Imported once for its side effect, from the root layout, before any screen
 * renders. Registration is global and idempotent, so it belongs in one place
 * rather than repeated per screen the way icons are.
 *
 * `SafeAreaView` is the one that mattered. Unregistered, NativeWind treated a
 * `className` on it as a mistake and called `printUpgradeWarning`, which
 * JSON-stringifies the offending component's props to show you what it saw.
 * On a screen where SafeAreaView wraps everything, those props include the
 * entire child tree — and stringifying that walks into React Navigation's
 * context getter, which throws "Couldn't find a navigation context. Have you
 * wrapped your app with 'NavigationContainer'?"
 *
 * That message sent us looking for a missing provider on a screen whose
 * provider was fine. The navigation error was never the fault; it was thrown by
 * the code printing the warning about this.
 */
cssInterop(SafeAreaView, { className: 'style' });
