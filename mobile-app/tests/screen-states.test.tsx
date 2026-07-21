import { render, screen } from '@testing-library/react-native';

import { LoadingState } from '../src/components/ScreenStates';
import { AppThemeProvider, darkColors, lightColors } from '../src/theme';
import { usePreferencesStore } from '../src/stores/preferences.store';

afterEach(() => {
  usePreferencesStore.setState({ themePreference: 'system' });
});

it.each([
  ['light', lightColors.canvas],
  ['dark', darkColors.canvas],
] as const)('uses the %s theme canvas while loading', async (theme, canvas) => {
  usePreferencesStore.setState({ themePreference: theme });

  const view = await render(
    <AppThemeProvider>
      <LoadingState label="Preparing inspection" />
    </AppThemeProvider>,
  );

  expect(screen.getByTestId('loading-state')).toHaveStyle({ backgroundColor: canvas });
  expect(screen.getByRole('progressbar')).toHaveProp('accessibilityState', { busy: true });
  expect(screen.getByText('Preparing inspection')).toBeOnTheScreen();
  await view.unmount();
});
