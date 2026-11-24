import { CameraView, useCameraPermissions } from 'expo-camera';
import { FlashlightIcon, FlashlightOffIcon } from 'lucide-react-native';
import { useRef, useState, type ReactNode } from 'react';
import { Linking, Modal, Pressable, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/src/components/ui';
import { registerIcons } from '@/src/lib/icons';
import { acceptScan, type SeenLabels } from '@/src/utils/item-scan';

registerIcons(FlashlightIcon, FlashlightOffIcon);

/**
 * The phone as a bar code scanner (2026-11-19; full screen since 2026-11-24,
 * approved on the Inventory Screens canvas). The camera fills the screen,
 * looking for an item label; it reads both codes a label carries, the stripes
 * (Code 128) and the QR square, and hands back what they hold, which is the
 * item code. A light for a dark truck, and "Type the code instead" for a label
 * that will not read: the code is printed under the square.
 *
 * Open only while somebody is scanning, so the camera is not running behind a
 * list. A label held in view is read many times a second: each code is handed
 * back once while it stays in view, and again only after it has been out of
 * view for a pause, so one label is one scan (`acceptScan`).
 *
 * The camera's surface is the one place colours are fixed rather than themed:
 * it is a picture of a truck, not a themed page (like GuidedCaptureOverlay).
 * Nothing leaves the phone to read a label, and nothing billed is called.
 */
export function ItemScanner({
  title,
  hint,
  onCode,
  said,
  onClose,
  tray,
}: {
  /** "Scan to take · Truck 1". */
  title: string;
  /** What a scan does here, shown until the first one. */
  hint: string;
  onCode: (code: string) => void;
  /** What the last scan did. */
  said: { words: string; bad: boolean } | null;
  onClose: () => void;
  /** What has been scanned so far, under the camera. */
  tray?: ReactNode;
}) {
  const [permission, request] = useCameraPermissions();
  const seen = useRef<SeenLabels>(new Map());
  const [light, setLight] = useState(false);
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState('');
  const insets = useSafeAreaInsets();

  const useTyped = () => {
    if (!typed.trim()) return;
    onCode(typed);
    setTyped('');
  };

  return (
    <Modal animationType="slide" onRequestClose={onClose} presentationStyle="fullScreen" visible>
      <View className="flex-1 bg-black" style={{ paddingTop: insets.top }}>
        <View className="flex-row items-center gap-2 px-4 py-2">
          <Pressable accessibilityRole="button" className="min-h-11 justify-center rounded-xl bg-white/15 px-4 active:opacity-70" onPress={onClose}>
            <Text className="text-base font-semibold text-white">Done</Text>
          </Pressable>
          <Text className="flex-1 text-center text-base font-semibold text-white" numberOfLines={1}>
            {title}
          </Text>
          <Pressable
            accessibilityLabel={light ? 'Turn the light off' : 'Turn the light on'}
            accessibilityRole="button"
            accessibilityState={{ selected: light }}
            className="h-11 w-11 items-center justify-center rounded-xl bg-white/15 active:opacity-70"
            onPress={() => setLight((on) => !on)}
          >
            {light ? <FlashlightOffIcon className="text-white" size={20} /> : <FlashlightIcon className="text-white" size={20} />}
          </Pressable>
        </View>

        <View className="mx-3 flex-1 overflow-hidden rounded-2xl bg-black">
          {permission?.granted ? (
            <>
              <CameraView
                barcodeScannerSettings={{ barcodeTypes: ['code128', 'qr'] }}
                enableTorch={light}
                facing="back"
                onBarcodeScanned={({ data }) => {
                  if (acceptScan(seen.current, data, Date.now())) onCode(data);
                }}
                style={{ flex: 1 }}
              />
              {/* The corners a label is held inside. */}
              <View className="absolute inset-x-16 inset-y-16" importantForAccessibility="no-hide-descendants" pointerEvents="none">
                <View className="absolute left-0 top-0 h-9 w-9 border-l-4 border-t-4 border-white" />
                <View className="absolute right-0 top-0 h-9 w-9 border-r-4 border-t-4 border-white" />
                <View className="absolute bottom-0 left-0 h-9 w-9 border-b-4 border-l-4 border-white" />
                <View className="absolute bottom-0 right-0 h-9 w-9 border-b-4 border-r-4 border-white" />
              </View>
              <Text className="absolute inset-x-0 bottom-4 text-center text-sm text-white">Hold the label inside the corners</Text>
            </>
          ) : permission ? (
            <View className="flex-1 justify-center gap-3 p-5">
              <Text className="text-base leading-relaxed text-white">Scanning a label uses the camera.</Text>
              {permission.canAskAgain ? (
                <Button label="Allow the camera" onPress={() => void request()} />
              ) : (
                <Button label="Open Settings to allow the camera" onPress={() => void Linking.openSettings()} variant="secondary" />
              )}
            </View>
          ) : null}
        </View>

        <View className="items-center px-4 py-3">
          {typing ? (
            <View className="w-full flex-row items-center gap-2">
              <TextInput
                accessibilityLabel="Item code"
                autoCapitalize="characters"
                autoCorrect={false}
                autoFocus
                className="min-h-12 flex-1 rounded-xl bg-white px-4 text-lg font-semibold text-black"
                onChangeText={setTyped}
                onSubmitEditing={useTyped}
                placeholder="FLT-16251"
                returnKeyType="done"
                value={typed}
              />
              <Pressable accessibilityRole="button" className="min-h-12 justify-center rounded-xl bg-white/15 px-4 active:opacity-70" onPress={useTyped}>
                <Text className="text-base font-semibold text-white">Find</Text>
              </Pressable>
            </View>
          ) : (
            <Pressable accessibilityRole="button" className="min-h-11 justify-center rounded-xl bg-white/15 px-4 active:opacity-70" onPress={() => setTyping(true)}>
              <Text className="text-base font-semibold text-white">Type the code instead</Text>
            </Pressable>
          )}
        </View>

        <View className="gap-3 rounded-t-3xl bg-background px-5 pt-4" style={{ paddingBottom: Math.max(insets.bottom, 16) }}>
          <Text
            accessibilityLiveRegion="polite"
            accessibilityRole={said?.bad ? 'alert' : 'text'}
            className={`rounded-xl px-3 py-2.5 text-sm ${said ? (said.bad ? 'bg-destructive/10 font-semibold text-destructive' : 'bg-primary/10 font-semibold text-primary') : 'text-muted-foreground'}`}
          >
            {said ? said.words : hint}
          </Text>
          {tray}
          <Button label="Done scanning" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}
