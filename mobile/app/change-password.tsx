import { useState } from 'react';
import { useColorScheme } from 'nativewind';
import { EyeIcon, EyeOffIcon } from 'lucide-react-native';
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

import { useRequiredPasswordChange } from '@/src/features/queries';
import { registerIcons } from '@/src/lib/icons';

registerIcons(EyeIcon, EyeOffIcon);

export default function ChangePasswordScreen() {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const changePassword = useRequiredPasswordChange();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [validationError, setValidationError] = useState('');

  const submit = async () => {
    setValidationError('');
    if (password.length < 8) {
      setValidationError('Choose a password with at least 8 characters.');
      return;
    }
    if (password !== confirmation) {
      setValidationError('The passwords do not match.');
      return;
    }
    try {
      await changePassword.mutateAsync(password);
      router.replace('/login');
    } catch {
      // Safe repository error is rendered below.
    }
  };

  const error =
    validationError || (changePassword.error instanceof Error ? changePassword.error.message : '');

  return (
    // Matches the sign-in screen this one follows. Centred content with two
    // fields and a button was fine until the keyboard opened, which on a
    // smaller display covered the confirm field and the button under it —
    // leaving a technician retyping a password they could not see, on the one
    // screen they cannot skip past to reach their work.
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
          <Text className="text-3xl font-bold text-foreground">Secure your account</Text>
          <Text className="mt-2 text-base leading-6 text-muted-foreground">
            Replace the temporary password before opening assigned inspections.
          </Text>
          {error ? (
            <View
              accessibilityLiveRegion="assertive"
              accessibilityRole="alert"
              className="mt-5 rounded-xl bg-destructive/10 px-4 py-3"
            >
              <Text className="text-sm text-destructive">{error}</Text>
            </View>
          ) : null}
          {/* These fields have no visible label — only a placeholder, which
            disappears the moment typing starts and which several screen
            readers skip entirely. The explicit labels are the only thing
            distinguishing the two password boxes. */}
          {/* One toggle for both fields, unlike sign-in's single box: the two
              hold the same secret, and being able to read them together is how
              a mismatch gets spotted before the error message says so. */}
          <View className="mt-6 flex-row items-center rounded-xl border border-border bg-card">
            <TextInput
              accessibilityLabel="New password"
              className="min-h-12 flex-1 px-4 py-4 text-base text-foreground"
              placeholder="New password"
              placeholderTextColor={isDark ? '#5e6b78' : '#9a9484'}
              secureTextEntry={!showPassword}
              textContentType="newPassword"
              value={password}
              onChangeText={setPassword}
            />
            <Pressable
              accessibilityHint="Applies to both password fields"
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
          <TextInput
            accessibilityLabel="Confirm new password"
            className="mt-3 min-h-12 rounded-xl border border-border bg-card px-4 py-4 text-base text-foreground"
            placeholder="Confirm new password"
            placeholderTextColor={isDark ? '#5e6b78' : '#9a9484'}
            secureTextEntry={!showPassword}
            textContentType="newPassword"
            value={confirmation}
            onChangeText={setConfirmation}
          />
          <Pressable
            accessibilityLabel={changePassword.isPending ? 'Updating password' : 'Update password'}
            accessibilityRole="button"
            accessibilityState={{
              busy: changePassword.isPending,
              disabled: changePassword.isPending,
            }}
            className="mt-5 min-h-12 items-center justify-center rounded-xl bg-primary py-4 active:scale-[0.98]"
            disabled={changePassword.isPending}
            onPress={() => void submit()}
          >
            <Text className="text-base font-bold text-primary-foreground">
              {changePassword.isPending ? 'Updating…' : 'Update password'}
            </Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
