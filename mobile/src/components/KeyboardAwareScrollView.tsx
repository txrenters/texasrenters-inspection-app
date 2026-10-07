import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type RefObject } from 'react';
import {
  Keyboard,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  type LayoutChangeEvent,
  type ScrollViewProps,
} from 'react-native';

/**
 * A screen's scroll view that keeps the field being typed in above the keyboard.
 *
 * A technician typing an area's note could not see what they typed: the
 * keyboard covered the "Finish this area" box, and sliding the screen up only
 * sprang back, because nothing told the scroll view the keyboard was there
 * (Moses, 2026-10-08). A plain `ScrollView` knows nothing about the keyboard on
 * either platform -- and on Android this SDK draws edge to edge, so the window
 * no longer shrinks for the keyboard either.
 *
 * - iOS: `automaticallyAdjustKeyboardInsets` adds the keyboard's height to the
 *   bottom inset, so the content can be slid up past it and stays there.
 * - Android: the same room, as bottom padding, from the keyboard's reported
 *   height.
 * - Both: once the keyboard is up, and again whenever the content grows -- a
 *   note gaining a line -- the field being typed in is scrolled whole above
 *   it. iOS's own adjustment brings only the caret's line into view, so the
 *   next line typed went straight back under the keyboard.
 *
 * Taps behave as before: the first tap outside the field closes the keyboard.
 * The area note is saved when the field loses focus, so letting a tap reach
 * "Submit area" with the keyboard still up would submit before the note saved.
 */

/** Clear space kept between the bottom of the field and the top of the keyboard. */
export const KEYBOARD_CLEARANCE = 24;

/**
 * Where to scroll so a field sits wholly above the keyboard, or null when it
 * already does.
 *
 * All in window coordinates except `inContent`, the field's top within the
 * scrolled content, which together with the field's place on screen gives the
 * current scroll position without listening to every scroll event.
 */
export function revealScrollTarget(measured: {
  /** The field's top within the scroll view's content. */
  inContent: number;
  /** The field's top on screen. */
  inWindow: number;
  height: number;
  /** The scroll view's top on screen. */
  scrollTop: number;
  /** The keyboard's top on screen. */
  keyboardTop: number;
  clearance?: number;
}): number | null {
  const { inContent, inWindow, height, scrollTop, keyboardTop, clearance = KEYBOARD_CLEARANCE } = measured;
  const hiddenBy = inWindow + height + clearance - keyboardTop;
  if (hiddenBy <= 0) return null;
  const scrolledBy = inContent - (inWindow - scrollTop);
  // Never so far that the field's own top goes off the top of the list.
  const furthest = scrolledBy + Math.max(0, inWindow - scrollTop);
  return Math.max(0, Math.min(scrolledBy + hiddenBy, furthest));
}

export const KeyboardAwareScrollView = forwardRef<ScrollView, ScrollViewProps>(function KeyboardAwareScrollView(
  { contentContainerStyle, onContentSizeChange, onLayout, ...props },
  forwardedRef,
) {
  const scrollRef = useRef<ScrollView>(null);
  const contentRef = useRef<View>(null);
  useImperativeHandle(forwardedRef, () => scrollRef.current as ScrollView, []);
  const keyboardTop = useRef<number | null>(null);
  const [androidKeyboardHeight, setAndroidKeyboardHeight] = useState(0);

  const reveal = useCallback(() => {
    const top = keyboardTop.current;
    const scroll = scrollRef.current;
    const input = TextInput.State.currentlyFocusedInput();
    const content = contentRef.current;
    const frame = scroll?.getNativeScrollRef();
    if (top === null || !scroll || !input || !content || !frame) return;
    // Measured against this list's own content, which fails for a field that
    // is not in it -- one in a sheet over this screen -- so that moves nothing.
    input.measureLayout(
      content,
      (_x, inContent, _width, height) => {
        input.measureInWindow((_inputX, inWindow) => {
          frame.measureInWindow((_frameX, scrollTop) => {
            const target = revealScrollTarget({ inContent, inWindow, height, scrollTop, keyboardTop: top });
            if (target !== null) scroll.scrollTo({ y: target, animated: true });
          });
        });
      },
      () => undefined,
    );
  }, []);

  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', (event) => {
      keyboardTop.current = event.endCoordinates.screenY;
      if (Platform.OS === 'android') setAndroidKeyboardHeight(event.endCoordinates.height);
      reveal();
    });
    const hidden = Keyboard.addListener('keyboardDidHide', () => {
      keyboardTop.current = null;
      if (Platform.OS === 'android') setAndroidKeyboardHeight(0);
    });
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, [reveal]);

  const basePadding = StyleSheet.flatten(contentContainerStyle)?.paddingBottom;

  return (
    <ScrollView
      ref={scrollRef}
      // React 19's refs include null; this prop's older declaration does not.
      innerViewRef={contentRef as RefObject<View>}
      automaticallyAdjustKeyboardInsets
      {...props}
      contentContainerStyle={[
        contentContainerStyle,
        androidKeyboardHeight > 0
          ? { paddingBottom: (typeof basePadding === 'number' ? basePadding : 0) + androidKeyboardHeight }
          : null,
      ]}
      onContentSizeChange={(width, height) => {
        onContentSizeChange?.(width, height);
        // A note gaining a line, or Android's padding arriving.
        if (keyboardTop.current !== null) reveal();
      }}
      onLayout={(event: LayoutChangeEvent) => {
        onLayout?.(event);
        if (keyboardTop.current !== null) reveal();
      }}
    />
  );
});
