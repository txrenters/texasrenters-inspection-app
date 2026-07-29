import { Platform, Pressable } from 'react-native';
import Animated from 'react-native-reanimated';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * This component is used to wrap animated views that should only be animated on native.
 * @param props - The props for the animated view.
 * @returns The animated view if the platform is native, otherwise the children.
 * @example
 * <NativeOnlyAnimatedView entering={FadeIn} exiting={FadeOut}>
 *   <Text>I am only animated on native</Text>
 * </NativeOnlyAnimatedView>
 */
function NativeOnlyAnimatedView(
  props:
    | (React.ComponentPropsWithoutRef<typeof Animated.View> & { as?: 'View' })
    | (React.ComponentPropsWithoutRef<typeof AnimatedPressable> & { as: 'Pressable' }),
) {
  if (Platform.OS === 'web') {
    return <>{props.children as React.ReactNode}</>;
  }

  if (props.as === 'Pressable') {
    // @ts-expect-error -- the current registry's Reanimated SharedValue `key`
    // type is wider than React 19's intrinsic key even though the runtime
    // component accepts these animated props.
    return <AnimatedPressable {...props} />;
  }

  return <Animated.View {...props} />;
}

export { NativeOnlyAnimatedView };
