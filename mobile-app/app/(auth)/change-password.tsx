import { useState } from 'react';
import { router } from 'expo-router';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BrandLogo } from '../../src/components/BrandLogo';
import { AppButton, Card, StatusBadge } from '../../src/components/ui';
import { useRequiredPasswordChange } from '../../src/features/queries';
import { type AppColors, spacing, typography, useThemedStyles } from '../../src/theme';

export default function ChangePasswordScreen() {
  const styles = useThemedStyles(createStyles);
  const change = useRequiredPasswordChange();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const valid = password.length >= 12 && password === confirmation;

  if (change.isSuccess)
    return (
      <SafeAreaView style={styles.root}>
        <View style={styles.centered}>
          <Card>
            <Text style={styles.title}>Password changed</Text>
            <Text style={styles.body}>
              Your temporary password can no longer be used. Sign in again with your new password.
            </Text>
            <AppButton label="Return to sign in" onPress={() => router.replace('/(auth)/login')} />
          </Card>
        </View>
      </SafeAreaView>
    );

  return (
    <SafeAreaView style={styles.root}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <ScrollView contentContainerStyle={styles.centered} keyboardShouldPersistTaps="handled">
          <View style={styles.header}>
            <BrandLogo compact />
            <StatusBadge label="REQUIRED" tone="warning" />
          </View>
          <Card>
            <Text style={styles.eyebrow}>FIRST SIGN-IN</Text>
            <Text style={styles.title}>Create your private password</Text>
            <Text style={styles.body}>
              Replace the temporary password before accessing any assigned inspections. Use at least
              12 characters.
            </Text>
            <Text style={styles.label}>New password</Text>
            <TextInput
              accessibilityLabel="New password"
              autoCapitalize="none"
              autoComplete="new-password"
              secureTextEntry
              style={styles.input}
              value={password}
              onChangeText={(value) => {
                setPassword(value);
                change.reset();
              }}
            />
            <Text style={styles.label}>Confirm new password</Text>
            <TextInput
              accessibilityLabel="Confirm new password"
              autoCapitalize="none"
              autoComplete="new-password"
              secureTextEntry
              style={styles.input}
              value={confirmation}
              onChangeText={(value) => {
                setConfirmation(value);
                change.reset();
              }}
            />
            {confirmation && password !== confirmation ? (
              <Text style={styles.error}>Passwords do not match.</Text>
            ) : null}
            {change.error ? <Text style={styles.error}>{change.error.message}</Text> : null}
            <AppButton
              disabled={!valid}
              label="Set new password"
              loading={change.isPending}
              onPress={() => change.mutate(password)}
            />
          </Card>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const createStyles = (colors: AppColors) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    flex: { flex: 1 },
    centered: {
      flexGrow: 1,
      width: '100%',
      maxWidth: 560,
      alignSelf: 'center',
      justifyContent: 'center',
      gap: spacing.lg,
      padding: spacing.lg,
    },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    eyebrow: { ...typography.label, color: colors.primary, letterSpacing: 1.2 },
    title: { ...typography.display, color: colors.textPrimary },
    body: { ...typography.body, color: colors.textSecondary },
    label: { ...typography.label, color: colors.textPrimary },
    input: {
      minHeight: 54,
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 12,
      paddingHorizontal: spacing.md,
      color: colors.textPrimary,
      backgroundColor: colors.background,
    },
    error: { ...typography.caption, color: colors.danger },
  });
