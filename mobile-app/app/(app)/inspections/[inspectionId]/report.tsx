import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { AppScreen } from '../../../../src/components/AppScreen';
import { ErrorState, LoadingState } from '../../../../src/components/ScreenStates';
import { Card, SectionHeader, StatusBadge, formatStatus } from '../../../../src/components/ui';
import { useInspectionReport } from '../../../../src/features/queries';
import { type AppColors, spacing, typography, useThemedStyles } from '../../../../src/theme';
import type { InspectionReportRoom } from '../../../../src/domain/models';

const finishedStatuses = ['COMPLETED', 'SKIPPED', 'RECORDING_SAVED'];

export default function InspectionReportScreen() {
  const styles = useThemedStyles(createStyles);
  const { inspectionId = '' } = useLocalSearchParams<{ inspectionId: string }>();
  const query = useInspectionReport(inspectionId);
  if (query.isLoading) return <LoadingState label="Building consolidated report…" />;
  if (!query.data)
    return (
      <ErrorState
        message={query.error?.message ?? 'Report unavailable'}
        onRetry={() => void query.refetch()}
      />
    );
  const { inspection, property, rooms, totals, generatedAt } = query.data;
  const finishedRooms = rooms.filter((room) => finishedStatuses.includes(room.completionStatus));
  const unfinishedRooms = rooms.filter((room) => !finishedStatuses.includes(room.completionStatus));
  return (
    <AppScreen
      title="Inspection report"
      subtitle={`${property.address} · ${formatStatus(inspection.type)} inspection`}
      refresh={{ onRefresh: () => query.refetch() }}
    >
      <Card muted>
        <View style={styles.statusRow}>
          <StatusBadge label={inspection.status} />
          {inspection.type === 'MOVE_IN' ? (
            <StatusBadge label="BASELINE SOURCE" tone="info" />
          ) : null}
        </View>
        <Text style={styles.metaText}>
          Generated {new Date(generatedAt).toLocaleString()} · {totals.finishedRooms} of{' '}
          {totals.rooms} rooms finished · {totals.defectFindings} finding
          {totals.defectFindings === 1 ? '' : 's'} for review
        </Text>
        {inspection.type === 'MOVE_IN' ? (
          <Text style={styles.baselineNote}>
            This move-in report becomes the comparison baseline for every future inspection of this
            property.
          </Text>
        ) : null}
        {totals.pendingReviewCount > 0 ? (
          <Text style={styles.pendingNote}>
            {totals.pendingReviewCount} finding{totals.pendingReviewCount === 1 ? '' : 's'} still
            await admin review before any tenant charge decision.
          </Text>
        ) : null}
      </Card>
      <SectionHeader title={`Finished rooms (${finishedRooms.length})`} />
      {finishedRooms.length ? (
        finishedRooms.map((room) => <ReportRoomCard key={room.id} room={room} />)
      ) : (
        <Card muted>
          <Text style={styles.metaText}>No rooms have a finished inspection yet.</Text>
        </Card>
      )}
      {unfinishedRooms.length ? (
        <>
          <SectionHeader title={`Not finished yet (${unfinishedRooms.length})`} />
          {unfinishedRooms.map((room) => (
            <Card key={room.id} muted>
              <View style={styles.roomHeader}>
                <Text style={styles.roomName}>{room.name}</Text>
                <StatusBadge label={room.completionStatus} />
              </View>
              <Text style={styles.metaText}>{room.floorName}</Text>
            </Card>
          ))}
        </>
      ) : null}
    </AppScreen>
  );
}

function ReportRoomCard({ room }: { room: InspectionReportRoom }) {
  const styles = useThemedStyles(createStyles);
  return (
    <Card>
      <View style={styles.roomHeader}>
        <Text style={styles.roomName}>{room.name}</Text>
        <StatusBadge label={room.completionStatus} />
      </View>
      <Text style={styles.metaText}>{room.floorName}</Text>
      {room.completionStatus === 'SKIPPED' && room.skipReason ? (
        <Text style={styles.metaText}>Skipped: {room.skipReason}</Text>
      ) : null}
      <Text style={styles.summaryLabel}>AI CONDITION SUMMARY</Text>
      <Text style={styles.summaryText}>
        {room.summary ??
          (room.processingStatus === 'READY_FOR_REVIEW'
            ? 'No summary was produced for this room.'
            : 'The recording is still being transcribed and summarized.')}
      </Text>
      {room.findings.length ? (
        <View style={styles.findings}>
          <Text style={styles.summaryLabel}>FINDINGS FOR REVIEW</Text>
          {room.findings.map((finding) => (
            <View key={finding.id} style={styles.finding}>
              <View style={styles.findingHeader}>
                <Text style={styles.findingTitle}>{finding.title}</Text>
                <StatusBadge
                  label={finding.severity}
                  tone={finding.severity === 'HIGH' ? 'danger' : undefined}
                />
              </View>
              <Text style={styles.findingBody}>{finding.description}</Text>
              <Text style={styles.findingMeta}>
                {formatStatus(finding.category)} · {formatStatus(finding.reviewStatus)}
              </Text>
            </View>
          ))}
        </View>
      ) : (
        <Text style={styles.metaText}>No reviewable findings were reported for this room.</Text>
      )}
      {room.note ? <Text style={styles.metaText}>Technician note: {room.note}</Text> : null}
    </Card>
  );
}

const createStyles = (colors: AppColors) =>
  StyleSheet.create({
    statusRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    metaText: { ...typography.caption, color: colors.textSecondary },
    baselineNote: { ...typography.caption, color: colors.primary, fontWeight: '700' },
    pendingNote: { ...typography.caption, color: colors.warning },
    roomHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    roomName: { ...typography.heading, color: colors.textPrimary, flexShrink: 1 },
    summaryLabel: {
      ...typography.caption,
      color: colors.primary,
      fontWeight: '800',
      letterSpacing: 0.6,
      marginTop: spacing.xs,
    },
    summaryText: { ...typography.body, color: colors.textPrimary },
    findings: { gap: spacing.sm },
    finding: {
      gap: 4,
      padding: spacing.sm,
      borderRadius: 10,
      backgroundColor: colors.background,
    },
    findingHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    findingTitle: { ...typography.body, color: colors.textPrimary, fontWeight: '700', flex: 1 },
    findingBody: { ...typography.caption, color: colors.textSecondary },
    findingMeta: { ...typography.caption, color: colors.textSecondary },
  });
