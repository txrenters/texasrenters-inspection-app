-- An approver may approve their own requisition (the office, 2026-11-21). Sending
-- back and rejecting stay somebody else's: the requester takes theirs back instead.
ALTER TABLE "PurchaseRequisition" DROP CONSTRAINT "PurchaseRequisition_not_decided_by_its_requester";
ALTER TABLE "PurchaseRequisition" ADD CONSTRAINT "PurchaseRequisition_sent_back_or_rejected_by_another" CHECK (
    "status" NOT IN ('SENT_BACK', 'REJECTED') OR "decidedById" IS NULL OR "decidedById" <> "requestedById"
);

-- Reopen (2026-11-20) sends an approved requisition back with no decider, as
-- NAV's Reopen does; this check refused it. Approved and rejected still name
-- who decided and when; one sent back by an approver still names them.
ALTER TABLE "PurchaseRequisition" DROP CONSTRAINT "PurchaseRequisition_a_decision_has_its_decider";
ALTER TABLE "PurchaseRequisition" ADD CONSTRAINT "PurchaseRequisition_a_decision_has_its_decider" CHECK (
    "status" NOT IN ('APPROVED', 'REJECTED') OR ("decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL)
);
