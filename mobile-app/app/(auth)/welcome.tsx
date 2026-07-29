import { router } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BrandLogo } from '../../src/components/BrandLogo';
import { AppButton, PropertyVisual, StatusBadge } from '../../src/components/ui';
import { isDemoMode } from '../../src/config/environment';
import { type AppColors, radius, spacing, typography, useThemedStyles } from '../../src/theme';

const FEATURES = ['Room-by-room capture', 'Reliable upload queue', 'Human-reviewed findings'];

export default function WelcomeScreen() {
  const styles = useThemedStyles(createStyles);
  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <View style={styles.content}>
          <View style={styles.brandRow}>
            <BrandLogo compact />
            <View style={styles.brandSpacer} />
            <StatusBadge
              label={isDemoMode ? 'DEMO' : 'SECURE'}
              tone={isDemoMode ? 'info' : 'success'}
            />
          </View>

          <View style={styles.hero}>
            <PropertyVisual tone="teal" />
            <View style={styles.heroCopy}>
              <Text style={styles.eyebrow}>TEXAS RENTERS INSPECTION</Text>
              <Text style={styles.title}>Property inspections, room by room.</Text>
              <Text style={styles.body}>
                Capture focused evidence, keep uploads moving, and review AI-assisted findings with
                a human in control.
              </Text>
            </View>
            <View style={styles.featureList}>
              {FEATURES.map((feature) => (
                <View key={feature} style={styles.featureItem}>
                  <View style={styles.featureCheck}>
                    <Text style={styles.featureCheckText}>✓</Text>
                  </View>
                  <Text style={styles.featureText}>{feature}</Text>
                </View>
              ))}
            </View>
          </View>

          <View style={styles.assurance}>
            <View style={styles.assuranceIcon}>
              <Text style={styles.assuranceIconText}>{isDemoMode ? 'i' : '✓'}</Text>
            </View>
            <View style={styles.assuranceCopy}>
              <Text style={styles.assuranceTitle}>
                {isDemoMode ? 'Ready without a backend' : 'Secure account access'}
              </Text>
              <Text style={styles.assuranceBody}>
                {isDemoMode
                  ? 'Explore realistic local data and safely simulated processing.'
                  : 'Sign in with your Texas Renters account to access inspections assigned to you.'}
              </Text>
            </View>
          </View>

          <View style={styles.actionGroup}>
            <AppButton
              label={isDemoMode ? 'Enter demo workspace' : 'Continue to sign in'}
              onPress={() => router.push('/(auth)/login')}
            />
            {!isDemoMode ? (
              <Text style={styles.authorizedText}>Authorized Texas Renters team members only</Text>
            ) : null}
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const createStyles = (colors: AppColors) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    scrollContent: { flexGrow: 1, padding: spacing.lg },
    content: {
      flexGrow: 1,
      width: '100%',
      minWidth: 0,
      maxWidth: 720,
      alignSelf: 'center',
      justifyContent: 'space-between',
      gap: spacing.lg,
    },
    brandRow: {
      minWidth: 0,
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: spacing.sm,
    },
    brandSpacer: { flex: 1 },
    hero: { gap: spacing.lg },
    heroCopy: { gap: spacing.sm },
    eyebrow: { ...typography.label, color: colors.primary, letterSpacing: 1.3 },
    title: { ...typography.display, color: colors.textPrimary },
    body: { ...typography.body, color: colors.textSecondary, fontSize: 16, lineHeight: 24 },
    featureList: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    featureItem: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      minWidth: 190,
      flexGrow: 1,
    },
    featureCheck: {
      width: 24,
      height: 24,
      borderRadius: radius.round,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.secondarySoft,
    },
    featureCheckText: { ...typography.caption, color: colors.secondaryDark, fontWeight: '800' },
    featureText: { ...typography.caption, color: colors.textPrimary, flexShrink: 1 },
    assurance: {
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'flex-start',
      backgroundColor: colors.primarySoft,
      borderRadius: radius.lg,
      padding: spacing.md,
      gap: spacing.md,
    },
    assuranceIcon: {
      width: 34,
      height: 34,
      borderRadius: radius.round,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surface,
    },
    assuranceIconText: { ...typography.label, color: colors.primary, fontWeight: '800' },
    assuranceCopy: { flex: 1, minWidth: 0, gap: spacing.xs },
    assuranceTitle: { ...typography.label, color: colors.primaryDark },
    assuranceBody: { ...typography.caption, color: colors.textSecondary },
    actionGroup: { gap: spacing.sm },
    authorizedText: { ...typography.caption, color: colors.textSecondary, textAlign: 'center' },
  });
