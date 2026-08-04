import { Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useNetworkStore } from '../stores/network.store';

/**
 * Says the device is offline, before anything is attempted.
 *
 * Reads already survive this — they fall back to the SQLite cache — so the
 * failure a technician actually meets is a write: a note, a skip reason, an
 * added area. Those still fail, and until they are queued the honest thing is
 * to say so up front rather than let someone type a skip reason in a basement
 * and discover on submit that it went nowhere.
 *
 * Recordings are the exception worth naming here, because they are the work.
 * They are already queued durably and will send on their own, so a technician
 * who sees this banner should keep recording rather than stop and find signal.
 */
export function OfflineBanner() {
  const insets = useSafeAreaInsets();
  // Primitive selectors: zustand v5 has no default shallow compare, and an
  // object literal here would make a new snapshot every render.
  const isOnline = useNetworkStore((state) => state.isOnline);
  const isResolved = useNetworkStore((state) => state.isResolved);

  // Nothing until NetInfo has actually reported. The store starts optimistic so
  // the upload queue is not stalled on launch, and flashing "offline" for that
  // first moment would be a lie on every cold start.
  if (!isResolved || isOnline) return null;

  return (
    <View
      accessibilityLiveRegion="polite"
      accessibilityRole="alert"
      className="bg-chart-4/20 px-5 pb-2.5"
      style={{ paddingTop: Math.max(insets.top, 10) }}
    >
      <Text className="text-sm font-semibold text-foreground">No connection</Text>
      <Text className="mt-0.5 text-xs leading-4 text-muted-foreground">
        Keep recording — uploads are queued and send when you are back. Notes, skips and new areas
        need a connection to save.
      </Text>
    </View>
  );
}
