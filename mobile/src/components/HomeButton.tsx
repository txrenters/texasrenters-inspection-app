import { useState } from 'react';
import { HouseIcon } from 'lucide-react-native';
import { Modal, Pressable, Text, View } from 'react-native';

import { registerIcons } from '../lib/icons';
import { goHome } from '../lib/navigation';

registerIcons(HouseIcon);

/**
 * Returns to the home tabs from anywhere in the signed-in stack.
 *
 * Every screen below the tabs had only a back arrow, so a technician deep in a
 * walkthrough — home → inspection → area → camera → recording review — had to
 * press back four times to get out. `dismissAll` pops the whole stack in one
 * action, landing on whichever tab they left from.
 */
export function HomeButton({
  /**
   * Shown as a confirmation before leaving. Pass this from any screen holding
   * work that going home would throw away; omit it where leaving is harmless.
   */
  confirm,
  /**
   * `overlay` for screens drawn on top of the camera preview, where a
   * theme-coloured pill would be a light chip on a dark viewfinder.
   */
  tone = 'surface',
}: {
  confirm?: { title: string; detail: string; leaveLabel: string };
  tone?: 'surface' | 'overlay';
}) {
  const [asking, setAsking] = useState(false);
  const overlay = tone === 'overlay';

  const leave = () => {
    setAsking(false);
    // goHome dismisses the whole stack rather than pushing: pushing home would
    // leave the abandoned inspection screens underneath it, so the next back
    // press would walk right back into the walkthrough just left. It also guards
    // POP_TO_TOP, which is unhandled on a screen opened cold.
    goHome();
  };

  return (
    <>
      <Pressable
        accessibilityHint="Leaves this inspection and returns to your work queue"
        accessibilityLabel="Home"
        accessibilityRole="button"
        className={`items-center justify-center rounded-full active:scale-[0.98] ${
          overlay ? 'h-10 w-10 bg-black/40' : 'h-9 w-9 bg-card'
        }`}
        hitSlop={8}
        onPress={() => (confirm ? setAsking(true) : leave())}
      >
        <HouseIcon size={overlay ? 21 : 18} className={overlay ? 'text-white' : 'text-foreground'} />
      </Pressable>

      {confirm ? (
        <Modal
          animationType="fade"
          transparent
          visible={asking}
          onRequestClose={() => setAsking(false)}
        >
          <View className="flex-1 justify-end bg-black/55">
            <View
              accessibilityRole="alert"
              accessibilityViewIsModal
              className="rounded-t-3xl bg-background px-5 pb-10 pt-6"
            >
              <Text className="text-xl font-bold text-foreground">{confirm.title}</Text>
              <Text className="mt-2 text-sm leading-5 text-muted-foreground">{confirm.detail}</Text>
              <View className="mt-5 flex-row gap-3">
                <Pressable
                  accessibilityLabel="Stay here"
                  accessibilityRole="button"
                  className="min-h-12 flex-1 items-center justify-center rounded-xl border border-border py-3"
                  onPress={() => setAsking(false)}
                >
                  <Text className="font-semibold text-foreground">Stay</Text>
                </Pressable>
                <Pressable
                  accessibilityLabel={confirm.leaveLabel}
                  accessibilityRole="button"
                  className="min-h-12 flex-1 items-center justify-center rounded-xl bg-destructive py-3"
                  onPress={leave}
                >
                  <Text className="font-bold text-white">{confirm.leaveLabel}</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      ) : null}
    </>
  );
}
