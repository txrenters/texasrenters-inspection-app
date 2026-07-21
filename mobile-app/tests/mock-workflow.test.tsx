import type { PropsWithChildren } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router, useLocalSearchParams } from 'expo-router';

import WelcomeScreen from '../app/(auth)/welcome';
import LoginScreen from '../app/(auth)/login';
import DashboardScreen from '../app/(app)/(tabs)/dashboard';
import FloorPlanScreen from '../app/(app)/properties/[propertyId]/floor-plan';
import { FindingSummaryCard, RoomCard } from '../src/components/FeatureCards';
import { environment, isDemoMode } from '../src/config/environment';
import { matchesInspectionFilter } from '../src/features/queries';
import { repositories } from '../src/repositories';
import { rooms, seedFindings } from '../src/repositories/mock/data';
import { useDemoStore } from '../src/stores/demo.store';

function TestProvider({ children }: PropsWithChildren) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false, gcTime: Infinity },
    },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(useLocalSearchParams).mockReturnValue({});
  useDemoStore.getState().resetDemoData();
});

describe('mock-first application', () => {
  it('launches without environment configuration and defaults to mock mode', async () => {
    expect(environment.dataSource).toBe('mock');
    expect(environment.apiBaseUrl).toBeNull();
    expect(isDemoMode).toBe(true);
    await render(<WelcomeScreen />);
    expect(screen.getByText('Property inspections, room by room.')).toBeOnTheScreen();
    expect(screen.getByText('Ready without a backend')).toBeOnTheScreen();
  });

  it('supports demo login for all three roles', async () => {
    await render(<LoginScreen />, { wrapper: TestProvider });
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Continue as Inspection Technician' }),
      ).toBeOnTheScreen(),
    );
    fireEvent.press(screen.getByRole('button', { name: 'Continue as Inspection Technician' }));
    await waitFor(() => expect(useDemoStore.getState().selectedUserId).toBe('demo-technician'));
    expect(router.replace).toHaveBeenCalledWith('/(app)/(tabs)/dashboard');
    expect(await repositories.auth.listDemoUsers()).toHaveLength(3);
  });

  it('provides dashboard-ready mock data and five inspections', async () => {
    const dashboard = await repositories.inspections.dashboard();
    const inspections = await repositories.inspections.list();
    expect(inspections).toHaveLength(5);
    expect(dashboard.assignments).toHaveLength(2);
    expect(dashboard.inProgress).toBe(2);
    expect(dashboard.completed).toBe(2);
  });

  it('renders the technician dashboard from mock repositories', async () => {
    useDemoStore.getState().selectUser('demo-technician');
    await render(<DashboardScreen />, { wrapper: TestProvider });
    await waitFor(() => expect(screen.getByText('Good morning, Maya')).toBeOnTheScreen());
    await waitFor(() => expect(screen.getByText('1458 Oak Ridge Drive')).toBeOnTheScreen());
    expect(screen.getByText('Today’s assignments')).toBeOnTheScreen();
    expect(screen.getByText('Pending uploads')).toBeOnTheScreen();
  });

  it('renders an empty floor-plan state for an assigned inspection without an approved plan', async () => {
    jest.mocked(useLocalSearchParams).mockReturnValue({
      propertyId: 'property-oak-ridge',
      inspectionId: 'inspection-oak',
    });

    await render(<FloorPlanScreen />, { wrapper: TestProvider });

    await waitFor(() => expect(screen.getByText('No floor plan available')).toBeOnTheScreen());
    expect(
      screen.getByText(
        'There is no approved floor plan available for this property. Contact your administrator to upload and approve one.',
      ),
    ).toBeOnTheScreen();
    expect(screen.queryByText('Couldn\u2019t load this screen')).not.toBeOnTheScreen();
  });

  it('keeps the floor-plan screen usable when only the plan request fails', async () => {
    jest.mocked(useLocalSearchParams).mockReturnValue({
      propertyId: 'property-oak-ridge',
      inspectionId: 'inspection-oak',
    });
    jest.spyOn(repositories.floorPlans, 'get').mockRejectedValueOnce(new Error('Network error'));

    await render(<FloorPlanScreen />, { wrapper: TestProvider });

    await waitFor(() =>
      expect(screen.getByText('Floor plan temporarily unavailable')).toBeOnTheScreen(),
    );
    expect(screen.getByRole('button', { name: 'Try floor plan again' })).toBeOnTheScreen();
    expect(screen.queryByText('Couldn\u2019t load this screen')).not.toBeOnTheScreen();
  });

  it('filters inspections by status', async () => {
    const inspections = await repositories.inspections.list();
    expect(
      inspections.filter((item) => matchesInspectionFilter(item.status, 'COMPLETED')),
    ).toHaveLength(2);
    expect(
      inspections.filter((item) => matchesInspectionFilter(item.status, 'SCHEDULED')),
    ).toHaveLength(1);
  });

  it('renders room status and invokes room navigation', async () => {
    const onPress = jest.fn();
    await render(<RoomCard room={rooms[8]!} onPress={onPress} />);
    expect(screen.getByText('Bedroom 1')).toBeOnTheScreen();
    expect(screen.getByText('Documented')).toBeOnTheScreen();
    fireEvent.press(screen.getByRole('button', { name: 'Start recording for Bedroom 1' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('saves one room-bound media record and creates an upload item', async () => {
    const media = await repositories.media.save({
      inspectionId: 'inspection-oak',
      roomId: 'room-oak-9',
      uri: 'mock://bedroom-1.mp4',
      durationSeconds: 38,
      estimatedSizeMb: 25.1,
      note: 'Bedroom 1 evidence',
    });
    const upload = await repositories.uploads.enqueue(media);
    expect(media.roomId).toBe('room-oak-9');
    expect(upload.roomId).toBe('room-oak-9');
    expect(await repositories.media.listForRoom('room-oak-9')).toHaveLength(1);
    expect(useDemoStore.getState().roomOverrides['room-oak-9']?.completionStatus).toBe(
      'RECORDING_SAVED',
    );
  });

  it('advances upload progress while online and retries failures', async () => {
    const before = useDemoStore.getState().uploads.find((item) => item.id === 'upload-living')!;
    await repositories.uploads.tick();
    const after = useDemoStore.getState().uploads.find((item) => item.id === 'upload-living')!;
    expect(after.progress).toBeGreaterThan(before.progress);
    await repositories.uploads.retry('upload-kitchen');
    expect(
      useDemoStore.getState().uploads.find((item) => item.id === 'upload-kitchen')?.status,
    ).toBe('PENDING');
  });

  it('keeps uploads pending when offline simulation is active', async () => {
    useDemoStore.getState().setOnline(false);
    const before = useDemoStore
      .getState()
      .uploads.find((item) => item.id === 'upload-living')!.progress;
    await repositories.uploads.tick();
    expect(
      useDemoStore.getState().uploads.find((item) => item.id === 'upload-living')?.progress,
    ).toBe(before);
  });

  it('advances the AI processing timeline', async () => {
    const before = useDemoStore
      .getState()
      .uploads.find((item) => item.id === 'upload-dining')!.processingProgress;
    await repositories.uploads.tick();
    const after = useDemoStore.getState().uploads.find((item) => item.id === 'upload-dining')!;
    expect(after.processingProgress).toBeGreaterThan(before);
    expect(after.processingStatus).not.toBe('NOT_STARTED');
  });

  it('renders uncertain AI findings and updates approval status', async () => {
    await render(<FindingSummaryCard finding={seedFindings[0]!} onPress={jest.fn()} />);
    expect(screen.getByText('Deep scratches near closet')).toBeOnTheScreen();
    expect(screen.getByText(/confidence/)).toBeOnTheScreen();
    const approved = await repositories.findings.approve('finding-bedroom-wall');
    expect(approved.reviewStatus).toBe('APPROVED');
  });

  it('requires reasons for rejection and reinspection', async () => {
    await expect(repositories.findings.reject('finding-bedroom-wall', ' ')).rejects.toThrow(
      'reason is required',
    );
    await expect(
      repositories.findings.requestReinspection('finding-bedroom-wall', ''),
    ).rejects.toThrow('reason is required');
    const result = await repositories.findings.requestReinspection(
      'finding-bedroom-wall',
      'Need a closer wall view',
    );
    expect(result.reviewStatus).toBe('REINSPECTION_REQUESTED');
  });

  it('requires a reason before skipping a required room', async () => {
    await expect(repositories.inspections.skipRoom('room-oak-9', '')).rejects.toThrow(
      'reason is required',
    );
    const room = await repositories.inspections.skipRoom('room-oak-9', 'Room was locked');
    expect(room.completionStatus).toBe('SKIPPED');
  });

  it('reset demo data clears persisted workflow changes', async () => {
    useDemoStore.getState().selectUser('demo-technician');
    await repositories.findings.approve('finding-bedroom-wall');
    useDemoStore.getState().updateRoom('room-oak-9', { note: 'Temporary note' });
    useDemoStore.getState().resetDemoData();
    expect(useDemoStore.getState().selectedUserId).toBeNull();
    expect(useDemoStore.getState().roomOverrides).toEqual({});
    expect(useDemoStore.getState().findings['finding-bedroom-wall']?.reviewStatus).toBe(
      'PENDING_REVIEW',
    );
  });
});
