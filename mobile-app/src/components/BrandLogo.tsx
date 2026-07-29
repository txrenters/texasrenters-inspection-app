import { Image, StyleSheet, Text, View } from 'react-native';

import logo from '../../assets/texasrenterslogo.webp';
import { type AppColors, brandColors, spacing, typography, useThemedStyles } from '../theme';

export function BrandLogo({ compact = false }: { compact?: boolean }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View accessibilityLabel="Texas Renters Inspection" style={styles.container}>
      <View style={[styles.logoPlate, compact && styles.compactPlate]}>
        <Image
          resizeMode="contain"
          source={logo}
          style={[styles.logo, compact && styles.compactLogo]}
        />
      </View>
      <Text style={[styles.inspection, compact && styles.compactInspection]}>INSPECTION</Text>
    </View>
  );
}

const createStyles = (colors: AppColors) =>
  StyleSheet.create({
    container: {
      maxWidth: '100%',
      minWidth: 0,
      alignItems: 'center',
      alignSelf: 'flex-start',
      gap: spacing.xs,
    },
    logoPlate: {
      width: 270,
      height: 78,
      justifyContent: 'center',
      borderRadius: 12,
      backgroundColor: brandColors.white,
      paddingHorizontal: spacing.sm,
    },
    compactPlate: { width: 176, maxWidth: '100%', height: 52, borderRadius: 9 },
    logo: { width: '100%', height: '100%' },
    compactLogo: { height: 50 },
    inspection: {
      ...typography.label,
      alignSelf: 'flex-end',
      color: colors.secondaryDark,
      fontSize: 13,
      letterSpacing: 4.5,
    },
    compactInspection: { fontSize: 10, letterSpacing: 3 },
  });
