import { render, screen } from '@testing-library/react-native';
import { useLocalSearchParams } from 'expo-router';

import RecordRoomScreen from '../app/(app)/inspections/[inspectionId]/area/[areaId]/record';

const mockDemoState = {
  addSnapshot: jest.fn(),
  selectedUserId: 'demo-technician',
  setDraftRecording: jest.fn(),
  snapshots: [],
  updateSnapshot: jest.fn(),
};

jest.mock('expo-camera', () => {
  const { View } = jest.requireActual('react-native');
  return {
    CameraView: () => <View testID="room-camera" />,
    useCameraPermissions: () => [
      { canAskAgain: true, granted: true },
      jest.fn(async () => ({ canAskAgain: true, granted: true })),
    ],
    useMicrophonePermissions: () => [
      { canAskAgain: true, granted: true },
      jest.fn(async () => ({ canAskAgain: true, granted: true })),
    ],
  };
});

jest.mock('../src/features/queries', () => ({
  useRoom: () => ({
    data: { environment: 'INDOOR', id: 'room-oak-5', name: 'Common Bathroom' },
  }),
}));

jest.mock('../src/stores/demo.store', () => ({
  useDemoStore: (selector: (state: typeof mockDemoState) => unknown) => selector(mockDemoState),
}));

jest.mock('../src/capture/use-guided-capture', () => ({
  useGuidedCaptureSensor: () => ({
    authorized: false,
    requestAccess: jest.fn(async () => false),
    reset: jest.fn(),
    tracker: {
      acceptedSamples: 0,
      clockwiseRotationDegrees: 0,
      counterClockwiseRotationDegrees: 0,
      rejectedSamples: 0,
    },
    trackerRef: {
      current: {
        acceptedSamples: 0,
        clockwiseRotationDegrees: 0,
        counterClockwiseRotationDegrees: 0,
        rejectedSamples: 0,
      },
    },
  }),
}));

describe('record room camera experience', () => {
  beforeEach(() => {
    jest.mocked(useLocalSearchParams).mockReturnValue({
      areaId: 'room-oak-5',
      inspectionId: 'inspection-oak',
    });
  });

  it('shows the guide once over a camera screen whose primary controls are already mounted', async () => {
    await render(<RecordRoomScreen />);

    expect(screen.getByTestId('room-camera')).toBeOnTheScreen();
    expect(screen.getByText('ONE-TIME CAPTURE GUIDE')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Snapshot' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Start recording' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Guide' })).toBeOnTheScreen();
  });
});
