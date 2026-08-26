import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import Constants from 'expo-constants';
import { EyeIcon, EyeOffIcon, LogInIcon, ShieldCheckIcon } from 'lucide-react-native';

import { SessionConflictError } from '@/src/auth/session';
import { useApiLogin } from '@/src/features/queries';
import { registerIcons } from '@/src/lib/icons';
import { useThemeColors } from '@/src/lib/theme-colors';
import { Button } from '@/src/components/ui';

registerIcons(LogInIcon);
registerIcons(ShieldCheckIcon);
registerIcons(EyeIcon);
registerIcons(EyeOffIcon);

export default function LoginScreen() {
  const theme = useThemeColors();
  const appName = Constants.expoConfig?.name ?? 'TexasRenters Inspect';
  const login = useApiLogin();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [validationError, setValidationError] = useState('');

  const handleLogin = async (takeOver = false) => {
    setValidationError('');
    if (!email.trim() || !password) {
      setValidationError('Enter your work email and password.');
      return;
    }
    try {
      const user = await login.mutateAsync({ email, password, takeOver });
      router.replace(user.mustChangePassword ? '/change-password' : '/(app)/(tabs)');
    } catch {
      // The repository returns a safe, technician-facing error message.
    }
  };

  // Only this one is answerable from here. A wrong password is not something a
  // second button can fix, so the takeover is offered for nothing else.
  const sessionHeldElsewhere = login.error instanceof SessionConflictError;

  const error =
    validationError ||
    (login.error instanceof Error ? login.error.message : login.isError ? 'Sign in failed.' : '');

  return (
    <SafeAreaView edges={['top', 'bottom']} className="flex-1 bg-background">
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        className="flex-1"
      >
        <ScrollView
          className="flex-1"
          contentContainerStyle={{
            flexGrow: 1,
            justifyContent: 'center',
            paddingHorizontal: 24,
            paddingBottom: 48,
          }}
          keyboardShouldPersistTaps="handled"
        >
          <View className="mb-10 items-center">
            <View className="mb-4 h-20 w-20 items-center justify-center rounded-3xl bg-primary">
              <ShieldCheckIcon size={36} className="text-primary-foreground" />
            </View>
            <Text className="text-2xl font-bold tracking-tight text-foreground">{appName}</Text>
            <Text className="mt-1 text-sm text-muted-foreground">
              Technician inspection workspace
            </Text>
          </View>

          {/* Assertive: a failed sign-in must interrupt, or a screen-reader
              user re-submits the same credentials without knowing why. */}
          {error ? (
            <View
              accessibilityLiveRegion="assertive"
              accessibilityRole="alert"
              className="mb-4 rounded-xl border border-destructive/20 bg-destructive/10 px-4 py-3"
            >
              <Text className="text-sm text-destructive">{error}</Text>
            </View>
          ) : null}

          <View className="mb-4 gap-2">
            <Text
              nativeID="login-email-label"
              className="ml-1 text-sm font-semibold text-foreground"
            >
              Work email
            </Text>
            <TextInput
              accessibilityLabel="Work email"
              accessibilityLabelledBy="login-email-label"
              className="min-h-12 rounded-xl border border-border bg-card px-4 py-3.5 text-base text-foreground"
              placeholder="you@texasrenters.com"
              placeholderTextColor={theme.mutedForeground}
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              autoComplete="email"
            />
          </View>

          <View className="mb-6 gap-2">
            <Text
              nativeID="login-password-label"
              className="ml-1 text-sm font-semibold text-foreground"
            >
              Password
            </Text>
            <View className="flex-row items-center rounded-xl border border-border bg-card">
              <TextInput
                accessibilityLabel="Password"
                accessibilityLabelledBy="login-password-label"
                className="min-h-12 flex-1 px-4 py-3.5 text-base text-foreground"
                placeholder="Enter your password"
                placeholderTextColor={theme.mutedForeground}
                value={password}
                onChangeText={setPassword}
                secureTextEntry={!showPassword}
                autoComplete="password"
              />
              <Pressable
                accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
                accessibilityRole="switch"
                accessibilityState={{ checked: showPassword }}
                className="min-h-11 min-w-11 items-center justify-center px-3 py-3"
                onPress={() => setShowPassword((value) => !value)}
              >
                {showPassword ? (
                  <EyeOffIcon size={20} className="text-muted-foreground" />
                ) : (
                  <EyeIcon size={20} className="text-muted-foreground" />
                )}
              </Pressable>
            </View>
          </View>

          {/* `opacity-70` over the primary fill used to carry the label down
              with the background, so the least readable control on the screen
              was the one the technician was waiting on. `Button` swaps the fill
              instead. */}
          <Button
            busy={login.isPending}
            busyLabel="Signing in…"
            icon={<LogInIcon size={20} className="text-primary-foreground" />}
            label="Sign in"
            onPress={() => void handleLogin()}
          />

          {/* Deliberately the quieter control, and never the default. Taking a
              handset over signs somebody out, possibly mid-walkthrough, so it
              should read as the considered second choice rather than as a way
              past an error message. */}
          {sessionHeldElsewhere ? (
            <Button
              accessibilityHint="Signs this account out on the other device and signs in here"
              busy={login.isPending}
              busyLabel="Signing in…"
              className="mt-3"
              disabled={login.isPending}
              label="Sign in here instead"
              onPress={() => void handleLogin(true)}
              variant="secondary"
            />
          ) : null}

          {/* Under the sign-in button rather than beside the password field:
              it is the answer to a failed attempt, so it belongs where the eye
              already is once signing in has not worked. */}
          <Button
            className="mt-3"
            label="Forgot password?"
            onPress={() => router.push('/forgot-password')}
            variant="quiet"
          />

          <View className="mt-8 items-center">
            <Text className="text-xs text-muted-foreground">
              Secure access for authorized technicians only
            </Text>
            <Text className="mt-1 text-xs text-muted-foreground">
              TexasRenters © {new Date().getFullYear()}
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
