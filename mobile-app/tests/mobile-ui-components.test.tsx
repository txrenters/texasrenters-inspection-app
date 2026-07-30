import { fireEvent, render, screen } from '@testing-library/react-native';

import { EmptyState, ErrorState } from '../src/components/ScreenStates';
import { InspectionSummaryCard, RoomCard } from '../src/components/FeatureCards';
import { StickyActionFooter } from '../src/components/ScreenPrimitives';
import { AppButton, ProgressBar, StatusBadge } from '../src/components/ui';
import type { Inspection, InspectionRoom } from '../src/domain/models';
import { AppThemeProvider } from '../src/theme';

function renderWithTheme(node: React.ReactNode) {
  return render(<AppThemeProvider>{node}</AppThemeProvider>);
}

describe('mobile UI foundation', () => {
  it('keeps the application button API accessible while using the reusable primitive', async () => {
    const onPress = jest.fn();
    await renderWithTheme(<AppButton label="Save inspection" onPress={onPress} />);

    const button = screen.getByLabelText('Save inspection');
    expect(button).toHaveProp('accessibilityRole', 'button');
    expect(button).toHaveProp('accessibilityState', { disabled: false, busy: false });

    fireEvent.press(button);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('exposes semantic status and progress information', async () => {
    await renderWithTheme(
      <>
        <StatusBadge label="PENDING_REVIEW" />
        <ProgressBar value={0.42} />
      </>,
    );

    expect(screen.getByLabelText('Pending Review')).toBeOnTheScreen();
    const progress = screen.getByRole('progressbar');
    expect(progress.props.accessibilityValue).toEqual(
      expect.objectContaining({ min: 0, max: 100, now: 42 }),
    );
    expect(progress).toHaveStyle({ width: '100%', minWidth: 0, height: 8, flexShrink: 0 });
  });

  it('renders actionable empty and error feedback without exposing raw failures', async () => {
    const onRetry = jest.fn();
    await renderWithTheme(
      <>
        <EmptyState title="No assignments" message="New assignments will appear here." />
        <ErrorState message="ECONNREFUSED localhost:3000" onRetry={onRetry} />
      </>,
    );

    expect(screen.getByText('No assignments')).toBeOnTheScreen();
    expect(screen.getByText('New assignments will appear here.')).toBeOnTheScreen();
    expect(
      screen.getByText('The information is temporarily unavailable. Your saved work is still safe.'),
    ).toBeOnTheScreen();

    fireEvent.press(screen.getByLabelText('Try loading this screen again'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('keeps inspection summary content in a shrink-safe native row', async () => {
    const inspection: Inspection = {
      id: 'inspection-ios-layout',
      externalInspectionId: 'external-ios-layout',
      propertyId: 'property-ios-layout',
      type: 'MOVE_IN',
      scheduledAt: '2099-07-24T12:00:00.000Z',
      assignedUserId: 'technician-ios-layout',
      status: 'IN_PROGRESS',
      priority: 'HIGH',
      roomIds: [],
      propertyNotes: '',
      property: {
        id: 'property-ios-layout',
        address: '1150 Chamboard Lane With A Long Native Title',
        cityStateZip: 'Houston, TX, 77018-3250',
        imageTone: 'sage',
      },
      progress: { completed: 0, total: 21, hasFailedUpload: false },
    };

    await renderWithTheme(
      <InspectionSummaryCard
        inspection={inspection}
        property={inspection.property}
        progress={inspection.progress}
        onPress={jest.fn()}
      />,
    );

    expect(screen.getByTestId('inspection-summary-card')).toHaveStyle({
      width: '100%',
      minWidth: 0,
      overflow: 'hidden',
    });
    expect(screen.getByTestId('inspection-summary-property-row')).toHaveStyle({
      width: '100%',
      minWidth: 0,
      flexDirection: 'row',
      flexWrap: 'nowrap',
      alignItems: 'flex-start',
    });
    expect(screen.getByTestId('inspection-summary-copy')).toHaveStyle({
      minWidth: 0,
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: 0,
    });
    expect(screen.getByLabelText('Move In')).toHaveStyle({
      maxWidth: '100%',
      flexShrink: 1,
      alignSelf: 'flex-start',
    });
    expect(screen.getByLabelText('Property image placeholder')).toHaveStyle({
      width: 78,
      minWidth: 78,
      maxWidth: 78,
      height: 72,
      flexShrink: 0,
    });
    expect(screen.getByTestId('inspection-summary-action-row')).toHaveStyle({
      minWidth: 0,
      flexWrap: 'wrap',
    });
  });

  it('keeps room cards compact instead of repeating the full processing pipeline', async () => {
    const room: InspectionRoom = {
      id: 'room-1',
      inspectionId: 'inspection-1',
      propertyAreaId: 'area-1',
      name: 'Foyer',
      floorName: 'Ground Floor',
      order: 1,
      isRequired: true,
      inspectionType: 'MOVE_IN',
      baseline: {
        summary: 'Initial condition is not available.',
        condition: 'NOT_AVAILABLE',
        existingDefects: [],
        evidenceCount: 0,
      },
      completionStatus: 'NOT_STARTED',
      uploadStatus: 'PENDING',
      processingStatus: 'NOT_STARTED',
    };

    await renderWithTheme(
      <RoomCard room={room} sequenceNumber={1} isUpNext onPress={jest.fn()} />,
    );

    expect(screen.getByText('No recording · Queued · AI pending')).toBeOnTheScreen();
    expect(screen.queryByText('Baseline')).not.toBeOnTheScreen();
    expect(screen.queryByText('Recording')).not.toBeOnTheScreen();
    expect(screen.queryByText('Upload')).not.toBeOnTheScreen();
    expect(screen.queryByText('AI review')).not.toBeOnTheScreen();
  });

  it('renders sticky actions on a semantic surface with safe minimum height', async () => {
    await renderWithTheme(
      <StickyActionFooter>
        <AppButton label="Continue" onPress={jest.fn()} />
      </StickyActionFooter>,
    );

    expect(screen.getByTestId('sticky-action-footer')).toHaveStyle({
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      minHeight: 88,
    });
  });
});
