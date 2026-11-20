import { Module } from '@nestjs/common';

import { ApiAuthGuard, PermissionsGuard } from '../common/auth';
import { InvoiceFileStorageService } from '../common/invoice-file-storage.service';
import { PurchasingFileStorageService } from '../common/purchasing-file-storage.service';
import { MailModule } from '../mail/mail.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { TechnicianModule } from '../technician/technician.module';
import { InspectionMediaStorageService } from '../technician/inspection-media-storage.service';
import { AccessController } from './access.controller';
import { AccessService } from './access.service';
import { AccountProfileService } from './account-profile.service';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { RoutingModule } from '../routing/routing.module';
import { XeroModule } from '../integrations/xero/xero.module';
import { PropertyGeocodeScheduler } from './property-geocode.scheduler';
import { PropertyGeocodingService } from './property-geocoding.service';
import { TechnicianTimelineService } from '../technician/technician-timeline.service';
import { AiEvaluationService } from './ai-evaluation.service';
import { AiGuidanceService } from './ai-guidance.service';
import { AiProviderSettingsService } from './ai-provider-settings.service';
import { ChargeService } from './charge.service';
import { ComparisonReportService } from './comparison-report.service';
import { ComparisonService } from './comparison.service';
import { InvoiceDeliveryController } from './invoice-delivery.controller';
import { InvoiceBatchDeliveryController, InvoiceEmailSettingsController, PaymentReceiptsController } from './invoice-emails.controller';
import { InvoiceFollowUpsScheduler } from './invoice-follow-ups.scheduler';
import { InvoiceAutoDraftsController } from './invoice-auto-drafts.controller';
import { InvoiceAutoDraftsScheduler } from './invoice-auto-drafts.scheduler';
import { InvoiceAutoDraftsService } from './invoice-auto-drafts.service';
import { InvoiceFollowUpsService } from './invoice-follow-ups.service';
import { PropertyAccountController, StatementSettingsController } from './property-account.controller';
import { PropertyAccountService } from './property-account.service';
import { InvoiceRecordsController, InvoiceTemplatesController } from './invoice-records.controller';
import { InvoiceRecordsService } from './invoice-records.service';
import { InvoiceTemplatesService } from './invoice-templates.service';
import { InvoiceDeliveryService } from './invoice-delivery.service';
import { InvoiceFilesController } from './invoice-files.controller';
import { InvoiceFilesService } from './invoice-files.service';
import { InvoiceSettingsController } from './invoice-settings.controller';
import { ActualVsBudgetController } from './actual-vs-budget.controller';
import { ActualVsBudgetGateway } from './actual-vs-budget.gateway';
import { ExcelSyncCallbackController, ExcelSyncController } from './excel/excel-sync.controller';
import { ExcelSyncScheduler } from './excel/excel-sync.scheduler';
import { ExcelSyncService } from './excel/excel-sync.service';
import { MicrosoftAuthService } from './excel/microsoft-auth.service';
import { ActualVsBudgetService } from './actual-vs-budget.service';
import { InventoryMonitoringController } from './inventory-monitoring.controller';
import { InventoryMonitoringService } from './inventory-monitoring.service';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { PurchasingCodesController } from './purchasing-codes.controller';
import { PurchasingCodesService } from './purchasing-codes.service';
import { PurchasingSetupController } from './purchasing-setup.controller';
import { PurchasingSetupService } from './purchasing-setup.service';
import { RequisitionApproversService } from './requisition-approvers';
import { RequisitionRemindersScheduler } from './requisition-reminders.scheduler';
import { StockCountsController } from './stock-counts.controller';
import { VendorBillsXeroController } from './vendor-bills-xero.controller';
import { VendorBillsXeroService } from './vendor-bills-xero.service';
import { StockCountsService } from './stock-counts.service';
import { StockSlipsController } from './stock-slips.controller';
import { StockSlipsService } from './stock-slips.service';
import { PurchasingController } from './purchasing.controller';
import { PurchasingService } from './purchasing.service';
import { RequisitionFilesService } from './requisition-files.service';
import { RequisitionNotesService } from './requisition-notes.service';
import { PurchaseOrdersController } from './purchase-orders.controller';
import { PurchaseOrdersService } from './purchase-orders.service';
import { PurchaseReceivingController } from './purchase-receiving.controller';
import { PurchaseReceivingService } from './purchase-receiving.service';
import { InvoiceReportsController } from './invoice-reports.controller';
import { InvoiceReportsService } from './invoice-reports.service';
import { InvoiceSettingsService } from './invoice-settings.service';
import { FloorPlanAdminService } from './floor-plan-admin.service';
import { AreaChecklistAiService } from './area-checklist-ai.service';
import { FloorPlanExtractionService } from './floor-plan-extraction.service';
import { FloorPlanStorageService } from './floor-plan-storage.service';
import { InspectCloudAiService } from './inspection-import/inspect-cloud-ai.service';
import { InspectionImportService } from './inspection-import/inspection-import.service';
import { AreaEvidenceService } from './area-evidence.service';
import { ProfileDeletionService } from './profile-deletion.service';
import { ReportShareService } from './report-share.service';
import { ReportsController } from './reports.controller';
import { InvoiceBatchService } from './invoice-batch.service';
import { InvoiceEditsController } from './invoice-edits.controller';
import { InvoiceEditsService } from './invoice-edits.service';
import { InvoicesController, PaymentsController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { InspectionNotesController } from './inspection-notes.controller';
import { InspectionNotesService } from './inspection-notes.service';
import { RescheduleRequestsController } from './reschedule-requests.controller';
import { RescheduleRequestsService } from './reschedule-requests.service';
import { RescheduleSweepScheduler } from './reschedule-sweep.scheduler';
import { AuthModule } from '../auth/auth.module';
import { MediaModule } from '../media/media.module';
import { LocalIdentityProvider } from '../auth/local-identity.provider';
import { IDENTITY_PROVIDER } from './identity-provider';
import { TechnicianProvisioningService } from './technician-provisioning.service';
import { TechnicianSkillsService } from './technician-skills.service';

@Module({
  // AuthModule for LocalIdentityProvider, so provisioning and the password
  // flows share one instance rather than each registering their own.
  // MediaModule for CloudflareStreamService: deleting an inspection has to
  // remove its Stream videos, or the footage stays billed for and unreachable.
  // No cycle — MediaModule imports TechnicianModule, never this one.
  // TechnicianModule for the location service the console's map reads. Safe in
  // this direction only — that module must never import this one, which is why
  // AreaChecklistAiService is provided there rather than imported from here.
  // XeroModule (2026-11-13): an invoice made here goes to its company's Xero at once, through the sender.
  imports: [RealtimeModule, MailModule, AuthModule, MediaModule, TechnicianModule, RoutingModule, XeroModule],
  controllers: [
    AdminController,
    AccessController,
    ReportsController,
    RescheduleRequestsController,
    InspectionNotesController,
    InvoicesController,
    InvoiceEditsController,
    InvoiceDeliveryController,
    InvoiceEmailSettingsController,
    InvoiceAutoDraftsController,
    InvoiceBatchDeliveryController,
    PaymentReceiptsController,
    PropertyAccountController,
    StatementSettingsController,
    InvoiceRecordsController,
    InvoiceTemplatesController,
    InvoiceSettingsController,
    InvoiceReportsController,
    ActualVsBudgetController,
    // Before InventoryController: `inventory/slips` must not be read as an item's id.
    StockSlipsController,
    StockCountsController,
    PurchasingCodesController,
    PurchasingSetupController,
    InventoryMonitoringController,
    VendorBillsXeroController,
    InventoryController,
    PurchasingController,
    PurchaseOrdersController,
    PurchaseReceivingController,
    ExcelSyncController,
    ExcelSyncCallbackController,
    InvoiceFilesController,
    PaymentsController,
  ],
  providers: [
    AdminService,
    InspectionNotesService,
    PropertyGeocodingService,
    TechnicianTimelineService,
    PropertyGeocodeScheduler,
    AccessService,
    AccountProfileService,
    AreaEvidenceService,
    AiGuidanceService,
    // Test runs of the AI against the office's decisions; reads the pipeline
    // TechnicianModule exports.
    AiEvaluationService,
    AiProviderSettingsService,
    ChargeService,
    ComparisonService,
    ComparisonReportService,
    FloorPlanAdminService,
    AreaChecklistAiService,
    FloorPlanExtractionService,
    FloorPlanStorageService,
    InspectCloudAiService,
    InspectionImportService,
    InspectionMediaStorageService,
    ProfileDeletionService,
    InvoiceDeliveryService,
    InvoiceFollowUpsService,
    InvoiceFollowUpsScheduler,
    InvoiceAutoDraftsService,
    InvoiceAutoDraftsScheduler,
    PropertyAccountService,
    InvoiceRecordsService,
    InvoiceTemplatesService,
    InvoiceSettingsService,
    InvoiceFilesService,
    InvoiceFileStorageService,
    ReportShareService,
    RescheduleRequestsService,
    RescheduleSweepScheduler,
    InvoicesService,
    InvoiceEditsService,
    InvoiceBatchService,
    InvoiceReportsService,
    ActualVsBudgetService,
    InventoryService,
    StockSlipsService,
    StockCountsService,
    PurchasingCodesService,
    PurchasingSetupService,
    RequisitionApproversService,
    RequisitionRemindersScheduler,
    InventoryMonitoringService,
    VendorBillsXeroService,
    PurchasingService,
    PurchasingFileStorageService,
    RequisitionFilesService,
    RequisitionNotesService,
    PurchaseOrdersService,
    PurchaseReceivingService,
    ActualVsBudgetGateway,
    MicrosoftAuthService,
    ExcelSyncService,
    ExcelSyncScheduler,
    TechnicianProvisioningService,
    TechnicianSkillsService,
    // One implementation now that Supabase is gone; the token remains so
    // call sites stay decoupled from whichever store is behind it.
    { provide: IDENTITY_PROVIDER, useExisting: LocalIdentityProvider },
    ApiAuthGuard,
    PermissionsGuard,
  ],
  // For the third-party gateway controller, which serves a curated read-only
  // slice of the same data rather than reimplementing the queries behind it.
  // `InspectionImportService` is exported for the Propertyware document
  // backfill, which finds the reports and hands them here rather than growing a
  // second importer beside this one.
  exports: [
    AdminService,
    PropertyGeocodingService,
    InspectionImportService,
    TechnicianSkillsService,
  ],
})
export class AdminModule {}
