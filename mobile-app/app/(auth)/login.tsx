import { useRef, useState } from 'react';
import { router } from 'expo-router';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  type TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CircleAlert, CircleCheck } from 'lucide-react-native';

import { BrandLogo } from '../../src/components/BrandLogo';
import { LoadingState } from '../../src/components/ScreenStates';
import { AppButton, InitialsAvatar, StatusBadge } from '../../src/components/ui';
import { Alert, AlertDescription, AlertTitle } from '../../src/components/ui/alert';
import { Input } from '../../src/components/ui/input';
import { isDemoMode } from '../../src/config/environment';
import type { DemoRole } from '../../src/domain/models';
import {
  useApiLogin,
  useDemoLogin,
  useDemoUsers,
  usePasswordReset,
} from '../../src/features/queries';
import {
  type AppColors,
  radius,
  shadows,
  spacing,
  typography,
  useThemedStyles,
} from '../../src/theme';

const validEmail = (value: string) => /^\S+@\S+\.\S+$/.test(value.trim());

export default function LoginScreen() {
  if (!isDemoMode) return <AccountLogin />;
  return <DemoLogin />;
}

function AccountLogin() {
  const styles = useThemedStyles(createStyles);
  const login = useApiLogin();
  const passwordReset = usePasswordReset();
  const passwordInput = useRef<TextInput>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [focusedField, setFocusedField] = useState<'email' | 'password' | null>(null);
  const [emailTouched, setEmailTouched] = useState(false);
  const [passwordTouched, setPasswordTouched] = useState(false);
  const [resetMode, setResetMode] = useState(false);

  const emailInvalid = emailTouched && !validEmail(email);
  const passwordInvalid = passwordTouched && password.length < 6;
  const canSubmit = validEmail(email) && (resetMode || password.length >= 6);

  const changeEmail = (value: string) => {
    setEmail(value);
    login.reset();
    passwordReset.reset();
  };

  const submit = () => {
    setEmailTouched(true);
    if (resetMode) {
      if (validEmail(email)) passwordReset.mutate(email);
      return;
    }
    setPasswordTouched(true);
    if (!validEmail(email) || password.length < 6) return;
    login.mutate(
      { email, password },
      {
        onSuccess: (user) =>
          router.replace(
            user.mustChangePassword ? '/(auth)/change-password' : '/(app)/(tabs)/dashboard',
          ),
      },
    );
  };

  return (
    <SafeAreaView style={styles.root}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.keyboardView}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.authShell}>
            <View style={styles.brandRow}>
              <BrandLogo compact />
              <View style={styles.flex} />
              <StatusBadge label="SECURE" tone="success" />
            </View>

            <View style={styles.intro}>
              <Text style={styles.eyebrow}>{resetMode ? 'ACCOUNT RECOVERY' : 'WELCOME BACK'}</Text>
              <Text style={styles.title}>
                {resetMode ? 'Reset your password' : 'Sign in to inspections'}
              </Text>
              <Text style={styles.body}>
                {resetMode
                  ? 'Enter your work email and we’ll send you a secure password reset link.'
                  : 'Access your assigned properties, recordings, and inspection progress.'}
              </Text>
            </View>

            <View style={styles.formCard}>
              <View style={styles.fieldGroup}>
                <Text style={styles.fieldLabel}>Email address</Text>
                <View
                  style={[
                    styles.inputShell,
                    focusedField === 'email' && styles.inputFocused,
                    emailInvalid && styles.inputInvalid,
                  ]}
                >
                  <Text style={styles.inputIcon}>@</Text>
                  <Input
                    accessibilityLabel="Email address"
                    autoCapitalize="none"
                    autoComplete="email"
                    blurOnSubmit={resetMode}
                    keyboardType="email-address"
                    onBlur={() => {
                      setEmailTouched(true);
                      setFocusedField(null);
                    }}
                    onChangeText={changeEmail}
                    onFocus={() => setFocusedField('email')}
                    onSubmitEditing={() => (resetMode ? submit() : passwordInput.current?.focus())}
                    placeholder="name@texasrenters.com"
                    placeholderTextColor={styles.placeholder.color}
                    returnKeyType={resetMode ? 'send' : 'next'}
                    className="h-auto flex-1 border-0 bg-transparent px-0 shadow-none dark:bg-transparent"
                    style={styles.input}
                    value={email}
                  />
                </View>
                {emailInvalid ? (
                  <Text style={styles.fieldError}>Enter a valid email address.</Text>
                ) : null}
              </View>

              {!resetMode ? (
                <View style={styles.fieldGroup}>
                  <View style={styles.labelRow}>
                    <Text style={styles.fieldLabel}>Password</Text>
                    <Pressable
                      accessibilityRole="button"
                      hitSlop={10}
                      onPress={() => {
                        passwordReset.reset();
                        setResetMode(true);
                      }}
                    >
                      <Text style={styles.textAction}>Forgot password?</Text>
                    </Pressable>
                  </View>
                  <View
                    style={[
                      styles.inputShell,
                      focusedField === 'password' && styles.inputFocused,
                      passwordInvalid && styles.inputInvalid,
                    ]}
                  >
                    <Text style={styles.inputIcon}>●</Text>
                    <Input
                      ref={passwordInput}
                      accessibilityLabel="Password"
                      autoCapitalize="none"
                      autoComplete="current-password"
                      onBlur={() => {
                        setPasswordTouched(true);
                        setFocusedField(null);
                      }}
                      onChangeText={(value) => {
                        setPassword(value);
                        login.reset();
                      }}
                      onFocus={() => setFocusedField('password')}
                      onSubmitEditing={submit}
                      placeholder="Enter your password"
                      placeholderTextColor={styles.placeholder.color}
                      returnKeyType="go"
                      secureTextEntry={!showPassword}
                      className="h-auto flex-1 border-0 bg-transparent px-0 shadow-none dark:bg-transparent"
                      style={styles.input}
                      value={password}
                    />
                    <Pressable
                      accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
                      accessibilityRole="button"
                      hitSlop={10}
                      onPress={() => setShowPassword((visible) => !visible)}
                    >
                      <Text style={styles.passwordAction}>{showPassword ? 'Hide' : 'Show'}</Text>
                    </Pressable>
                  </View>
                  {passwordInvalid ? (
                    <Text style={styles.fieldError}>
                      Password must contain at least 6 characters.
                    </Text>
                  ) : null}
                </View>
              ) : null}

              {login.isError ? (
                <Alert icon={CircleAlert} variant="destructive">
                  <AlertTitle>We couldn’t sign you in</AlertTitle>
                  <AlertDescription>{login.error.message}</AlertDescription>
                </Alert>
              ) : null}
              {passwordReset.isError ? (
                <Alert icon={CircleAlert} variant="destructive">
                  <AlertTitle>Reset link not sent</AlertTitle>
                  <AlertDescription>{passwordReset.error.message}</AlertDescription>
                </Alert>
              ) : null}
              {passwordReset.isSuccess ? (
                <Alert
                  icon={CircleCheck}
                  className="border-approved/40 bg-approved/10"
                  iconClassName="text-approved"
                >
                  <AlertTitle className="text-approved">Check your inbox</AlertTitle>
                  <AlertDescription>
                    A password reset link was sent if this account exists.
                  </AlertDescription>
                </Alert>
              ) : null}

              <AppButton
                disabled={!canSubmit}
                label={resetMode ? 'Send reset link' : 'Sign in'}
                loading={login.isPending || passwordReset.isPending}
                onPress={submit}
              />

              <View style={styles.securityNote}>
                <Text style={styles.securityIcon}>✓</Text>
                <Text style={styles.securityText}>
                  Protected account access for authorized team members.
                </Text>
              </View>
            </View>

            <Pressable
              accessibilityRole="button"
              onPress={() => {
                if (resetMode) {
                  passwordReset.reset();
                  setResetMode(false);
                } else {
                  router.back();
                }
              }}
              style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
            >
              <Text style={styles.backText}>
                ← {resetMode ? 'Back to sign in' : 'Back to welcome'}
              </Text>
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function DemoLogin() {
  const styles = useThemedStyles(createStyles);
  const users = useDemoUsers();
  const login = useDemoLogin();
  const select = (role: DemoRole) => {
    login.mutate(role, { onSuccess: () => router.replace('/(app)/(tabs)/dashboard') });
  };
  if (users.isLoading) return <LoadingState label="Loading demo roles…" />;
  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <View style={styles.authShell}>
          <View style={styles.brandRow}>
            <BrandLogo compact />
            <View style={styles.flex} />
            <StatusBadge label="DEMO" tone="info" />
          </View>
          <View style={styles.intro}>
            <Text style={styles.eyebrow}>DEMO WORKSPACE</Text>
            <Text style={styles.title}>Choose a role</Text>
            <Text style={styles.body}>
              Preview each local workflow. You can switch roles later in Settings.
            </Text>
          </View>
          <View style={styles.roleList}>
            {users.data?.map((user) => (
              <Pressable
                key={user.id}
                accessibilityRole="button"
                accessibilityLabel={`Continue as ${user.roleLabel}`}
                onPress={() => select(user.role)}
                style={({ pressed }) => [styles.roleCard, pressed && styles.pressed]}
              >
                <InitialsAvatar initials={user.initials} />
                <View style={styles.flex}>
                  <Text style={styles.name}>{user.name}</Text>
                  <Text style={styles.role}>{user.roleLabel}</Text>
                  {user.role === 'TECHNICIAN' ? (
                    <StatusBadge label="RECOMMENDED" tone="success" />
                  ) : null}
                </View>
                <Text style={styles.arrow}>›</Text>
              </Pressable>
            ))}
          </View>
          {login.isError ? <Text style={styles.error}>{login.error.message}</Text> : null}
          <AppButton label="Back" variant="ghost" onPress={() => router.back()} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const createStyles = (colors: AppColors) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    keyboardView: { flex: 1 },
    scrollContent: { flexGrow: 1, padding: spacing.lg },
    authShell: {
      width: '100%',
      maxWidth: 560,
      alignSelf: 'center',
      justifyContent: 'center',
      gap: spacing.lg,
      flexGrow: 1,
      paddingVertical: spacing.sm,
    },
    brandRow: {
      minWidth: 0,
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: spacing.sm,
    },
    intro: { gap: spacing.sm },
    eyebrow: { ...typography.label, color: colors.primary, letterSpacing: 1.4 },
    title: { ...typography.display, color: colors.textPrimary },
    body: { ...typography.body, color: colors.textSecondary, fontSize: 16, lineHeight: 24 },
    formCard: {
      gap: spacing.md,
      padding: spacing.lg,
      borderRadius: radius.xl,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      ...shadows.card,
    },
    fieldGroup: { gap: spacing.sm },
    labelRow: {
      minWidth: 0,
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    fieldLabel: { ...typography.label, color: colors.textPrimary },
    textAction: { ...typography.caption, color: colors.primary, fontWeight: '700' },
    inputShell: {
      minHeight: 54,
      flexDirection: 'row',
      alignItems: 'center',
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.md,
      backgroundColor: colors.background,
      paddingHorizontal: spacing.md,
    },
    inputFocused: { borderColor: colors.primary, borderWidth: 2 },
    inputInvalid: { borderColor: colors.danger },
    inputIcon: {
      width: 24,
      color: colors.textSecondary,
      fontSize: 15,
      textAlign: 'center',
      marginRight: spacing.sm,
    },
    input: {
      ...typography.body,
      flex: 1,
      minWidth: 0,
      color: colors.textPrimary,
      paddingVertical: 14,
    },
    placeholder: { color: colors.textSecondary },
    passwordAction: {
      ...typography.caption,
      color: colors.primary,
      fontWeight: '700',
      paddingLeft: spacing.sm,
    },
    fieldError: { ...typography.caption, color: colors.danger },
    error: { ...typography.caption, color: colors.danger },
    securityNote: {
      flexDirection: 'row',
      justifyContent: 'center',
      alignItems: 'center',
      gap: spacing.sm,
    },
    securityIcon: { ...typography.caption, color: colors.success, fontWeight: '800' },
    securityText: { ...typography.caption, color: colors.textSecondary, flexShrink: 1 },
    backButton: {
      alignSelf: 'center',
      minHeight: 44,
      justifyContent: 'center',
      paddingHorizontal: spacing.md,
    },
    backText: { ...typography.label, color: colors.primary },
    pressed: { opacity: 0.72 },
    flex: { flex: 1, gap: spacing.xs },
    roleList: { gap: spacing.md },
    roleCard: {
      minHeight: 100,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      padding: spacing.md,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: colors.border,
      backgroundColor: colors.surface,
      ...shadows.card,
    },
    name: { ...typography.heading, color: colors.textPrimary },
    role: { ...typography.body, color: colors.textSecondary },
    arrow: { color: colors.primary, fontSize: 32 },
  });
