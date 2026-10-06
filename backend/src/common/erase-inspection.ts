import type { Prisma } from '@prisma/client';

/**
 * Erases an inspection's rows: everything hanging off it, then the inspection.
 *
 * One implementation of an irreversible operation, shared by the console's
 * delete (`AdminService.eraseInspection`) and the Jobber sync removing an
 * inspection whose visit Jobber deleted or took off the calendar (the office,
 * 2026-10-07). Runs inside the caller's transaction; the caller writes the
 * audit row and clears storage after the commit.
 *
 * Ordering is dictated by the schema, not by preference. Most children of
 * `Inspection` have no `onDelete: Cascade`, so a bare `inspection.delete()`
 * fails on the first foreign key. Each step below removes a table that points
 * at something deleted later; the ones that *do* cascade
 * (`AreaEvidenceRequest`, `InspectionAreaChecklistResponse`,
 * `FindingFrameSuggestion`, `JobberOutboundTask`, `TbpQuarterPlanAnchor`,
 * `TimeSegment`) go with it, and the ones set to null (`TbpQuarterPlanStop`,
 * `LeaseScheduledInspection`, `TrackingGap`) are let go.
 */
export async function eraseInspectionRows(tx: Prisma.TransactionClient, id: string) {
  /**
   * Dependants are unlinked rather than deleted.
   *
   * `baselineInspectionId` and `parentInspectionId` are both
   * `onDelete: Restrict`, so a move-in that some move-out compares against
   * cannot simply be removed. Clearing the pointer keeps the other
   * inspection — and all of its evidence — intact; it loses its baseline
   * comparison, which the caller records in its audit metadata so the absence
   * is explainable later.
   */
  const [baselineOf, parentOf] = await Promise.all([
    tx.inspection.updateMany({
      where: { baselineInspectionId: id },
      data: { baselineInspectionId: null },
    }),
    tx.inspection.updateMany({
      where: { parentInspectionId: id },
      data: { parentInspectionId: null },
    }),
  ]);

  // No Prisma relation on either column, so these are matched by hand.
  // Area comparisons cascade from the comparison row.
  await tx.inspectionComparison.deleteMany({
    where: { OR: [{ moveOutInspectionId: id }, { moveInInspectionId: id }] },
  });

  // Charges reference findings and pet candidates, so they go first.
  await tx.charge.deleteMany({ where: { inspectionId: id } });
  await tx.petObservation.deleteMany({ where: { inspectionId: id } });
  await tx.petCandidate.deleteMany({ where: { inspectionId: id } });

  await tx.findingReview.deleteMany({ where: { finding: { inspectionId: id } } });
  // Photos carry a findingId as well as an area, so they precede findings.
  const deletedPhotos = await tx.inspectionPhoto.deleteMany({ where: { inspectionId: id } });

  /**
   * The three job tables that hang off a recording.
   *
   * None of them cascades, and none carries an `inspectionId` — they are
   * reachable only through `inspectionMediaId`, which is why an enumeration
   * that greps for `inspectionId` misses all three and the delete dies on
   * `AiAnalysisJob_inspectionMediaId_fkey` at the first recording.
   */
  const mediaOfInspection = { inspectionMedia: { inspectionId: id } };
  // Segments hang off the transcription job, not the media, and the
  // constraint is RESTRICT — so the job cannot go until its transcript does.
  await tx.transcriptSegment.deleteMany({
    where: { transcriptionJob: mediaOfInspection },
  });
  await tx.aiAnalysisJob.deleteMany({ where: mediaOfInspection });
  await tx.transcriptionJob.deleteMany({ where: mediaOfInspection });
  await tx.mediaProcessingEvent.deleteMany({ where: mediaOfInspection });

  /**
   * Findings before media, not after.
   *
   * `InspectionFinding.inspectionMediaId` points at the recording a finding
   * was raised from, so deleting the media first violates that constraint.
   * The reverse order is not symmetric — nothing in `InspectionMedia` points
   * back at a finding.
   */
  const deletedFindings = await tx.inspectionFinding.deleteMany({
    where: { inspectionId: id },
  });
  const deletedMedia = await tx.inspectionMedia.deleteMany({ where: { inspectionId: id } });

  await tx.mediaUploadSession.deleteMany({
    where: { inspectionArea: { inspectionId: id } },
  });
  await tx.inspectionAreaStatusHistory.deleteMany({
    where: { inspectionArea: { inspectionId: id } },
  });
  const deletedAreas = await tx.inspectionArea.deleteMany({ where: { inspectionId: id } });
  await tx.inspectionAssignment.deleteMany({ where: { inspectionId: id } });
  await tx.inspectionReportShare.deleteMany({ where: { inspectionId: id } });
  await tx.areaEvidenceRequest.deleteMany({ where: { inspectionId: id } });

  await tx.inspection.delete({ where: { id } });

  return {
    areas: deletedAreas.count,
    recordings: deletedMedia.count,
    photos: deletedPhotos.count,
    findings: deletedFindings.count,
    unlinkedBaselineOf: baselineOf.count,
    unlinkedParentOf: parentOf.count,
  };
}
