import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';

import { useRequiredPasswordChange } from '@/src/features/queries';

export default function ChangePasswordScreen() {
  const changePassword = useRequiredPasswordChange();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
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
    validationError ||
    (changePassword.error instanceof Error ? changePassword.error.message : '');

  return (
    <SafeAreaView edges={['top', 'bottom']} className="flex-1 bg-background px-6">
      <View className="flex-1 justify-center">
        <Text className="text-3xl font-bold text-foreground">Secure your account</Text>
        <Text className="mt-2 text-base leading-6 text-muted-foreground">
          Replace the temporary password before opening assigned inspections.
        </Text>
        {error ? (
          <View className="mt-5 rounded-xl bg-destructive/10 px-4 py-3">
            <Text className="text-sm text-destructive">{error}</Text>
          </View>
        ) : null}
        <TextInput
          className="mt-6 rounded-xl border border-border bg-card px-4 py-4 text-base text-foreground"
          placeholder="New password"
          placeholderTextColor="#9a9484"
          secureTextEntry
          value={password}
          onChangeText={setPassword}
        />
        <TextInput
          className="mt-3 rounded-xl border border-border bg-card px-4 py-4 text-base text-foreground"
          placeholder="Confirm new password"
          placeholderTextColor="#9a9484"
          secureTextEntry
          value={confirmation}
          onChangeText={setConfirmation}
        />
        <Pressable
          className="mt-5 items-center rounded-xl bg-primary py-4 active:scale-[0.98]"
          disabled={changePassword.isPending}
          onPress={() => void submit()}
        >
          <Text className="text-base font-bold text-primary-foreground">
            {changePassword.isPending ? 'Updating…' : 'Update password'}
          </Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}
