import { StyleSheet, Text, View } from 'react-native';

import { useNetworkStore } from '../stores/network.store';
import { type AppColors, spacing, useThemedStyles } from '../theme';

export function NetworkBanner() {
  const styles = useThemedStyles(createStyles);
  const isOnline = useNetworkStore((state) => state.isOnline);
  if (isOnline) return null;
  return (
    <View accessibilityLiveRegion="polite" style={styles.banner}>
      <View style={styles.dot} />
      <Text style={styles.text}>Offline simulation · recordings stay safely queued</Text>
    </View>
  );
}

const createStyles = (colors: AppColors) =>
  StyleSheet.create({
    banner: {
      minHeight: 40,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      backgroundColor: colors.warningSoft,
    },
    dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.warning },
    text: { color: colors.textPrimary, fontSize: 13, fontWeight: '600' },
  });
