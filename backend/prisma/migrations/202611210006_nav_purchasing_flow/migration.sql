-- NAV's purchasing flow (the office, 2026-11-21).

-- A requisition is for one department, whose approvers approve it.
ALTER TABLE "PurchaseRequisition" ADD COLUMN "departmentId" UUID;
ALTER TABLE "PurchaseRequisition" ADD CONSTRAINT "PurchaseRequisition_department_fkey"
    FOREIGN KEY ("organizationId", "departmentId") REFERENCES "PurchasingCode"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "PurchaseRequisition_organizationId_departmentId_idx" ON "PurchaseRequisition"("organizationId", "departmentId");

-- An approver approves the requisitions of the departments ticked for them; none ticked is every department.
ALTER TABLE "PurchasingPerson" ADD COLUMN "departmentIds" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];
ALTER TABLE "PurchasingPerson" ADD CONSTRAINT "PurchasingPerson_departments" CHECK (cardinality("departmentIds") <= 50);

-- The purchasing manager approves purchase orders before the purchaser sends them.
ALTER TABLE "Role" DROP CONSTRAINT "Role_purchasing_role";
ALTER TABLE "Role" ADD CONSTRAINT "Role_purchasing_role" CHECK ("purchasingRole" IS NULL OR "purchasingRole" IN (
    'REQUISITIONER', 'PURCHASER', 'APPROVER', 'PURCHASING_MANAGER', 'STOCK_KEEPER', 'RECEIVER', 'CODE_ADMIN', 'BILL_PAYER', 'PURCHASING_ADMIN'
));
