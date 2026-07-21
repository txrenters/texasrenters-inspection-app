import { act, fireEvent, render } from '@testing-library/react-native';
import { AppScreen } from '../src/components/AppScreen';
import { AppThemeProvider } from '../src/theme';

describe('AppScreen refresh behavior', () => {
  it('shows refresh progress only while a user-initiated refresh is pending', async () => {
    let finishRefresh: (() => void) | undefined;
    const onRefresh = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        }),
    );
    const view = await render(
      <AppThemeProvider>
        <AppScreen title="Assignments" refresh={{ onRefresh }} />
      </AppThemeProvider>,
    );
    const refreshControl = findRefreshControl(view.root!);

    expect(view.getByTestId('app-screen-scroll')).toHaveProp('accessibilityState', {
      busy: false,
    });
    await act(async () => fireEvent(refreshControl, 'refresh'));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(view.getByTestId('app-screen-scroll')).toHaveProp('accessibilityState', {
      busy: true,
    });

    await act(async () => finishRefresh?.());
    expect(view.getByTestId('app-screen-scroll')).toHaveProp('accessibilityState', {
      busy: false,
    });
  });
});

function findRefreshControl(root: NonNullable<Awaited<ReturnType<typeof render>>['root']>) {
  return root.queryAll((instance) => instance.type === 'RCTRefreshControl')[0]!;
}
