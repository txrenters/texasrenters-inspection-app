import { StyleSheet, Text, View } from 'react-native';

/**
 * The provider attribution, which is a contractual obligation rather than a
 * design decision.
 *
 * Google's Maps Platform terms require, wherever their imagery is displayed,
 * that the Google logo appear at 16-19dp tall with 10dp of clear space to its
 * left, right and top and 5dp below, that no other logo overlap or sit inside
 * that clear space, and that the data attribution ("Map data ©YYYY Google")
 * appear as well. Those numbers are theirs; they are not rounded to the app's
 * spacing scale and must not be.
 *
 * `NavMap` renders this itself rather than accepting it as a child, and it
 * renders it unconditionally. Made optional, it becomes a prop somebody omits
 * on a screen nobody reviews, and the obligation is then broken in production
 * by an omission rather than by a decision.
 *
 * TODO: draw the real asset. The wordmark below is *text styled to Google's
 * required metrics*, which is a stand-in, not compliance -- the terms require
 * their supplied logo. Before release, ship `google_on_non_white.png` (and its
 * @2x/@3x variants) from the Google Maps Platform brand-assets pack into
 * `mobile/assets/map/` and replace the `<Text>` with an `<Image>` at the same
 * height and the same clear space. It is a static asset, so it needs a store
 * build to reach the bundle; an OTA update cannot add it.
 */

/**
 * Google's own numbers. Not the app's spacing scale, deliberately.
 *
 * 17 sits in the middle of the permitted 16-19dp so that a font that renders a
 * point large or small on one platform still lands inside the range.
 */
const LOGO_HEIGHT = 17;
const CLEAR_SPACE = 10;
const CLEAR_SPACE_BOTTOM = 5;

export function MapAttribution({ text }: { text: string | null }) {
  return (
    <View pointerEvents="none" style={styles.container}>
      {/*
        The clear space is the padding on this view, so nothing can be laid out
        inside it: a sibling positioned over the logo would have to overlap this
        element, which the layout does not allow. That is the whole reason the
        spacing is here rather than on the parent.
      */}
      <View style={styles.logo}>
        <Text allowFontScaling={false} style={styles.wordmark}>
          Google
        </Text>
      </View>

      {text ? (
        <Text allowFontScaling={false} numberOfLines={1} style={styles.data}>
          {text}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  /**
   * These colours are not theme tokens, for the same reason
   * `GuidedCaptureOverlay` uses none: what sits behind this strip is map
   * imagery, which the palette does not control. A `--foreground` attribution
   * is black text over a dark road in light mode and invisible over a bright
   * roof in dark mode. Fixed white on a translucent scrim reads over both.
   *
   * `allowFontScaling` is off throughout because the permitted logo height is a
   * fixed range in dp; a device at 200% text size would otherwise render a
   * 34dp wordmark, which is outside what the terms allow.
   */
  container: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
  },
  logo: {
    paddingLeft: CLEAR_SPACE,
    paddingRight: CLEAR_SPACE,
    paddingTop: CLEAR_SPACE,
    paddingBottom: CLEAR_SPACE_BOTTOM,
  },
  wordmark: {
    height: LOGO_HEIGHT,
    lineHeight: LOGO_HEIGHT,
    fontSize: LOGO_HEIGHT - 3,
    fontWeight: '700',
    letterSpacing: -0.3,
    color: '#FFFFFF',
    // A shadow rather than a filled pill: the logo's clear space must stay
    // clear, and a background plate drawn to the edge of the padding is the
    // thing most likely to be read as encroaching on it.
    textShadowColor: 'rgba(0,0,0,0.85)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 3,
  },
  data: {
    marginRight: 6,
    marginBottom: CLEAR_SPACE_BOTTOM,
    maxWidth: '58%',
    borderRadius: 4,
    backgroundColor: 'rgba(3, 8, 12, 0.55)',
    paddingHorizontal: 5,
    paddingVertical: 2,
    fontSize: 9,
    color: 'rgba(255,255,255,0.86)',
  },
});
