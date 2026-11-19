import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRef } from 'react';
import { Linking, Text, View } from 'react-native';

import { Button } from '@/src/components/ui';
import { acceptScan, type LastScan } from '@/src/utils/item-scan';

/**
 * The phone as a bar code scanner (2026-11-19): the camera, looking for an
 * item label. It reads both codes a label carries, the stripes (Code 128) and
 * the QR square, and hands back what they hold, which is the item code.
 *
 * Shown only while somebody is scanning, so the camera is not running behind
 * a list. A label held in view is read many times a second: the same code is
 * handed back once, and again only after a pause, so one label is one item.
 *
 * Nothing leaves the phone to read a label, and nothing billed is called.
 */
export function ItemScanner({ onCode, said, onClose }: { onCode: (code: string) => void; /** What the last scan did, shown under the camera. */ said: { words: string; bad: boolean } | null; onClose: () => void }) {
  const [permission, request] = useCameraPermissions();
  const last = useRef<LastScan | null>(null);

  if (!permission) return null;
  if (!permission.granted)
    return (
      <View className="mx-5 gap-3 rounded-xl border border-border bg-card p-4">
        <Text className="text-sm leading-relaxed text-foreground">Scanning a label uses the camera.</Text>
        {permission.canAskAgain ? (
          <Button label="Allow the camera" onPress={() => void request()} />
        ) : (
          <Button label="Open Settings to allow the camera" onPress={() => void Linking.openSettings()} variant="secondary" />
        )}
        <Button label="Pick from the list instead" onPress={onClose} variant="secondary" />
      </View>
    );

  return (
    <View className="mx-5 gap-3">
      <View className="h-52 overflow-hidden rounded-xl bg-black">
        <CameraView
          barcodeScannerSettings={{ barcodeTypes: ['code128', 'qr'] }}
          facing="back"
          onBarcodeScanned={({ data }) => {
            const now = Date.now();
            if (!acceptScan(last.current, data, now)) return;
            last.current = { code: data, at: now };
            onCode(data);
          }}
          style={{ flex: 1 }}
        />
      </View>
      <Text accessibilityLiveRegion="polite" accessibilityRole={said?.bad ? 'alert' : 'text'} className={`text-sm ${said?.bad ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}>
        {said ? said.words : 'Point the camera at the label. Scan the same label again for one more.'}
      </Text>
      <Button label="Done scanning" onPress={onClose} variant="secondary" />
    </View>
  );
}
