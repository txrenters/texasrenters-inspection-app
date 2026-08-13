-- Why the office sent an inspection back, shown to the technician who receives it.
--
-- Stored rather than left in the audit log: an audit row is for people
-- reconstructing what happened later, and the technician standing in the
-- property needs to read it now. Before this, a reopened inspection simply
-- reappeared in their queue with no explanation and the reason lived only in
-- AuditLog.metadata, which no technician endpoint reads.
--
-- Cleared on their next submission, because by then they have acted on it.
ALTER TABLE "Inspection" ADD COLUMN "reopenReason" TEXT;
