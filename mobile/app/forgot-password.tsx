import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { KeyRoundIcon, MailCheckIcon, SendIcon } from 'lucide-react-native';

import { usePasswordReset } from '@/src/features/queries';
import { registerIcons } from '@/src/lib/icons';
import { useThemeColors } from '@/src/lib/theme-colors';
import { Button } from '@/src/components/ui';

registerIcons(KeyRoundIcon);
registerIcons(MailCheckIcon);
registerIcons(SendIcon);

export default function ForgotPasswordScreen() {
  const theme = useThemeColors();
  const reset = usePasswordReset();
  const [email, setEmail] = useState('');
  const [validationError, setValidationError] = useState('');
  const [sent, setSent] = useState(false);

  const handleSubmit = async () => {
    setValidationError('');
    if (!email.trim()) {
      setValidationError('Enter your work email.');
      return;
    }
    try {
      await reset.mutateAsync(email);
      setSent(true);
    } catch {
      // The repository returns a safe, technician-facing error message.
    }
  };

  const error =
    validationError ||
    (reset.error instanceof Error
      ? reset.error.message
      : reset.isError
        ? 'Could not send the reset link.'
        : '');

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
              {sent ? (
                <MailCheckIcon size={36} className="text-primary-foreground" />
              ) : (
                <KeyRoundIcon size={36} className="text-primary-foreground" />
              )}
            </View>
            <Text className="text-2xl font-bold tracking-tight text-foreground">
              {sent ? 'Check your email' : 'Reset your password'}
            </Text>
          </View>

          {sent ? (
            <View className="gap-4">
              {/* Deliberately says "if". The server answers the same whether or
                  not the address has an account, so that this form cannot be
                  used to find out which addresses are real — and the wording
                  has to match, or the screen leaks what the API withholds. */}
              <Text
                accessibilityLiveRegion="polite"
                className="text-center text-base text-foreground"
              >
                If {email.trim()} belongs to a technician account, a reset link is on its way.
              </Text>

              {/* Said plainly because it surprises people. The app registers no
                  deep-link handler, so the link cannot open here — it opens the
                  office console in a browser. A technician who expects to come
                  back to this screen will otherwise sit waiting on it. */}
              <Text className="text-center text-sm text-muted-foreground">
                The link opens in your browser and expires in an hour. Set your new password there,
                then come back and sign in.
              </Text>

              <Button
                className="mt-2"
                label="Back to sign in"
                onPress={() => router.replace('/login')}
              />

              <Button
                label="Send it again"
                onPress={() => setSent(false)}
                variant="quiet"
              />
            </View>
          ) : (
            <>
              <Text className="mb-6 text-center text-sm text-muted-foreground">
                Enter your work email and we will send you a link to set a new password.
              </Text>

              {/* Assertive: a failure must interrupt, or somebody re-submits the
                  same address without knowing why nothing happened. */}
              {error ? (
                <View
                  accessibilityLiveRegion="assertive"
                  accessibilityRole="alert"
                  className="mb-4 rounded-xl border border-destructive/20 bg-destructive/10 px-4 py-3"
                >
                  <Text className="text-sm text-destructive">{error}</Text>
                </View>
              ) : null}

              <View className="mb-6 gap-2">
                <Text
                  nativeID="reset-email-label"
                  className="ml-1 text-sm font-semibold text-foreground"
                >
                  Work email
                </Text>
                <TextInput
                  accessibilityLabel="Work email"
                  accessibilityLabelledBy="reset-email-label"
                  className="min-h-12 rounded-xl border border-border bg-card px-4 py-3.5 text-base text-foreground"
                  placeholder="you@texasrenters.com"
                  placeholderTextColor={theme.mutedForeground}
                  value={email}
                  onChangeText={setEmail}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                  autoComplete="email"
                  onSubmitEditing={() => void handleSubmit()}
                  returnKeyType="send"
                />
              </View>

              <Button
                busy={reset.isPending}
                busyLabel="Sending…"
                icon={<SendIcon size={20} className="text-primary-foreground" />}
                label="Send reset link"
                onPress={() => void handleSubmit()}
              />

              <Button
                className="mt-3"
                label="Back to sign in"
                onPress={() => router.back()}
                variant="quiet"
              />
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
