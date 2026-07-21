import type { PropsWithChildren } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react-native';

import UploadQueueScreen from '../app/(app)/(tabs)/uploads';
import type { UploadItem } from '../src/domain/models';
import { queryKeys } from '../src/features/queries';
import { repositories } from '../src/repositories';
import { useDemoStore } from '../src/stores/demo.store';

type RenderedNode = {
  type: string;
  props: Record<string, unknown>;
  children?: Array<RenderedNode | string> | null;
};

function findRenderedNode(node: RenderedNode | null, type: string): RenderedNode | null {
  if (!node) return null;
  if (node.type === type) return node;
  for (const child of node.children ?? []) {
    if (typeof child === 'string') continue;
    const match = findRenderedNode(child, type);
    if (match) return match;
  }
  return null;
}

describe('upload queue refresh behavior', () => {
  it('does not show pull-to-refresh during a background queue fetch', async () => {
    useDemoStore.getState().resetDemoData();
    const currentUploads = await repositories.uploads.list();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const Provider = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const originalSetInterval = globalThis.setInterval;
    let queueTimer: ReturnType<typeof setInterval> | undefined;
    const intervalSpy = jest
      .spyOn(globalThis, 'setInterval')
      .mockImplementation((callback, delay) => {
        const timer = originalSetInterval(callback, delay);
        if (delay === 850) queueTimer = timer;
        return timer;
      });

    const view = await render(<UploadQueueScreen />, { wrapper: Provider });
    await waitFor(() => expect(screen.getByText('Upload center')).toBeOnTheScreen());
    if (queueTimer) clearInterval(queueTimer);

    let resolveBackgroundFetch!: (uploads: UploadItem[]) => void;
    const backgroundFetch = new Promise<UploadItem[]>((resolve) => {
      resolveBackgroundFetch = resolve;
    });
    const listSpy = jest.spyOn(repositories.uploads, 'list').mockReturnValueOnce(backgroundFetch);

    await act(async () => {
      void client.refetchQueries({ queryKey: queryKeys.uploads });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(client.getQueryState(queryKeys.uploads)?.fetchStatus).toBe('fetching'),
    );

    const refreshControl = findRenderedNode(
      view.toJSON() as RenderedNode | null,
      'RCTRefreshControl',
    );
    expect(refreshControl?.props.refreshing).not.toBe(true);

    await act(async () => {
      resolveBackgroundFetch(currentUploads);
      await backgroundFetch;
    });
    await waitFor(() => expect(client.getQueryState(queryKeys.uploads)?.fetchStatus).toBe('idle'));
    listSpy.mockRestore();
    intervalSpy.mockRestore();
    await view.unmount();
    client.clear();
  }, 15_000);
});
