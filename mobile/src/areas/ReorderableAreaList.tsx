import { useCallback, useMemo, useRef, useState } from 'react';
import { PanResponder, View, type LayoutChangeEvent } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

/**
 * A list whose rows the technician can pick up and move.
 *
 * Built on `PanResponder` from React Native core and the Reanimated already in
 * this app, rather than a drag library. `react-native-draggable-flatlist` would
 * be less code but needs `react-native-gesture-handler` alongside it, and two
 * new native modules mean the feature cannot reach a handset until the next
 * native build. This ships over the air.
 *
 * **Long press to lift, not drag to lift.** The rows live inside a ScrollView,
 * and a pan that grabs immediately would fight scrolling — the technician would
 * try to scroll the list and start rearranging it instead. The press delay is
 * what separates the two gestures, and scrolling is disabled only while a row
 * is actually held.
 *
 * Row heights are measured rather than assumed. An area row grows a line when
 * it carries a baseline summary, so a fixed height would drift a few rows in
 * and drop the held row into the wrong gap.
 */

/** Long enough not to catch a scroll, short enough not to feel broken. */
const LIFT_AFTER_MS = 220;

export interface ReorderableAreaListProps<T> {
  items: readonly T[];
  keyOf: (item: T) => string;
  renderItem: (item: T, state: { dragging: boolean }) => React.ReactNode;
  /** The new order, once a row has been dropped. Not called for a drag that
   * ends where it began. */
  onReorder: (ids: string[]) => void;
  /** Turns the whole gesture off — a submitted inspection is not the
   * technician's to rearrange. */
  enabled?: boolean;
  /** Locks the ScrollView while a row is held, so the two gestures cannot both
   * act on the same finger. */
  onDragStateChange?: (dragging: boolean) => void;
}

export function ReorderableAreaList<T>({
  items,
  keyOf,
  renderItem,
  onReorder,
  enabled = true,
  onDragStateChange,
}: ReorderableAreaListProps<T>) {
  const heights = useRef<Map<string, number>>(new Map());
  const [heldKey, setHeldKey] = useState<string | null>(null);

  /**
   * Live, mutable copies for the gesture.
   *
   * A PanResponder is created once and closes over whatever it captured, so it
   * cannot read React state that changed after it was built. Refs are what let
   * the handlers see the current list.
   */
  const order = useRef<string[]>([]);
  order.current = items.map(keyOf);
  const held = useRef<{ key: string; from: number; to: number } | null>(null);

  const measure = useCallback((key: string, event: LayoutChangeEvent) => {
    heights.current.set(key, event.nativeEvent.layout.height);
  }, []);

  return (
    <View>
      {items.map((item) => {
        const key = keyOf(item);
        return (
          <Row
            dragging={heldKey === key}
            enabled={enabled}
            heights={heights}
            held={held}
            item={item}
            itemKey={key}
            key={key}
            onDragStateChange={onDragStateChange}
            onMeasure={measure}
            onReorder={onReorder}
            order={order}
            renderItem={renderItem}
            setHeldKey={setHeldKey}
          />
        );
      })}
    </View>
  );
}

function Row<T>({
  item,
  itemKey,
  dragging,
  enabled,
  heights,
  held,
  order,
  renderItem,
  onMeasure,
  onReorder,
  onDragStateChange,
  setHeldKey,
}: {
  item: T;
  itemKey: string;
  dragging: boolean;
  enabled: boolean;
  heights: React.RefObject<Map<string, number>>;
  held: React.RefObject<{ key: string; from: number; to: number } | null>;
  order: React.RefObject<string[]>;
  renderItem: (item: T, state: { dragging: boolean }) => React.ReactNode;
  onMeasure: (key: string, event: LayoutChangeEvent) => void;
  onReorder: (ids: string[]) => void;
  onDragStateChange?: (dragging: boolean) => void;
  setHeldKey: (key: string | null) => void;
}) {
  const translateY = useSharedValue(0);
  const lifted = useSharedValue(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** The height of a row, falling back to a typical one before it has laid out. */
  const heightOf = useCallback(
    (key: string) => heights.current?.get(key) ?? 72,
    [heights],
  );

  const release = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const active = held.current;
    held.current = null;
    setHeldKey(null);
    onDragStateChange?.(false);
    translateY.value = withTiming(0, { duration: 160 });
    lifted.value = withTiming(0, { duration: 160 });

    // A drag that ends where it began is not a reorder. Reporting one would
    // write a preference somebody did not ask for, and re-render the list for
    // no reason.
    if (!active || active.to === active.from) return;
    const next = [...(order.current ?? [])];
    const [moved] = next.splice(active.from, 1);
    if (moved) next.splice(active.to, 0, moved);
    onReorder(next);
  }, [held, lifted, onDragStateChange, onReorder, order, setHeldKey, translateY]);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        // Only claims the gesture once a row is actually held. Until then the
        // ScrollView owns the finger, which is what keeps scrolling working.
        onMoveShouldSetPanResponder: () => enabled && held.current?.key === itemKey,
        onPanResponderGrant: () => {
          if (!enabled) return;
          timer.current = setTimeout(() => {
            const from = (order.current ?? []).indexOf(itemKey);
            if (from < 0) return;
            held.current = { key: itemKey, from, to: from };
            setHeldKey(itemKey);
            onDragStateChange?.(true);
            lifted.value = withTiming(1, { duration: 120 });
          }, LIFT_AFTER_MS);
        },
        onPanResponderMove: (_event, gesture) => {
          const active = held.current;
          if (!active || active.key !== itemKey) {
            // Moved before the lift landed: this is a scroll, so drop the
            // pending long press rather than starting a drag mid-scroll.
            if (timer.current && Math.abs(gesture.dy) > 6) {
              clearTimeout(timer.current);
              timer.current = null;
            }
            return;
          }
          translateY.value = gesture.dy;

          // Which slot the row is over now. Measured heights rather than a
          // constant, because a row with a baseline summary is taller and the
          // error compounds down the list.
          const ids = order.current ?? [];
          const step = heightOf(itemKey);
          const moved = Math.round(gesture.dy / (step || 1));
          const next = Math.max(0, Math.min(ids.length - 1, active.from + moved));
          active.to = next;
        },
        onPanResponderRelease: release,
        onPanResponderTerminate: release,
      }),
    [enabled, held, heightOf, itemKey, lifted, onDragStateChange, order, release, setHeldKey, translateY],
  );

  const style = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }, { scale: 1 + lifted.value * 0.02 }],
    // Lifted above its neighbours so it is visibly the thing being moved, and
    // dimmed slightly so the gap it came from stays readable.
    zIndex: lifted.value > 0 ? 10 : 0,
    opacity: 1 - lifted.value * 0.06,
  }));

  return (
    <Animated.View
      onLayout={(event) => onMeasure(itemKey, event)}
      style={style}
      {...responder.panHandlers}
    >
      {renderItem(item, { dragging })}
    </Animated.View>
  );
}
