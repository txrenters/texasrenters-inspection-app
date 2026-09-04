import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { CronJob } from 'cron';

import { PROPERTYWARE_CONFIG } from '../../integrations/propertyware/propertyware.config';
import type { PropertywareConfig } from '../../integrations/propertyware/propertyware.types';
import { PropertywareTenantSyncService } from '../../integrations/propertyware/propertyware.tenant-sync.service';

/**
 * Keeps the tenancy report in step, once a day.
 *
 * Daily rather than hourly on purpose. This report is maintained by hand — a
 * benefit-package enrolment changes when somebody in the office edits it, not
 * on a schedule — so polling it more often would spend requests to re-read the
 * same 418 rows. It runs after the reconciliation sync, so the buildings a
 * tenancy is matched against are the ones that survived that pass.
 *
 * Requires its own report URL, and stays quiet without one. A tenancy sync with
 * nothing to read is not an error worth waking anybody for; it means the report
 * has not been configured yet, which the log says once at startup rather than
 * every day at three.
 */
@Injectable()
export class PropertywareTenantScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PropertywareTenantScheduler.name);
  private job?: CronJob;

  constructor(
    @Inject(PROPERTYWARE_CONFIG) private readonly config: PropertywareConfig,
    @Inject(PropertywareTenantSyncService) private readonly tenants: PropertywareTenantSyncService,
  ) {}

  onModuleInit() {
    if (!this.config.syncEnabled) {
      this.logger.log('Tenant sync is disabled (PROPERTYWARE_SYNC_ENABLED is not "true").');
      return;
    }
    if (!this.config.tenantReportUrl) {
      this.logger.log(
        'Tenant sync is idle: PROPERTYWARE_TENANT_REPORT_URL is not set, so there is no report to read.',
      );
      return;
    }
    const organizationId = this.config.schedulerOrganizationId;
    if (!organizationId) {
      this.logger.warn(
        'Tenant sync is enabled but PROPERTYWARE_LOCAL_ORGANIZATION_ID is not set; it will not run.',
      );
      return;
    }

    const cron = this.config.tenantSyncCron;
    try {
      this.job = new CronJob(cron, () => void this.run(organizationId));
    } catch {
      // A malformed expression must not take the application down with it —
      // every other sync would stop for a typo in one field.
      this.logger.error({
        event: 'propertyware_tenant_cron_invalid',
        cron,
        detail: 'PROPERTYWARE_TENANT_SYNC_CRON is not a valid cron expression; tenants will not sync.',
      });
      return;
    }
    this.job.start();
    this.logger.log({ event: 'propertyware_tenant_sync_scheduled', cron });
  }

  onModuleDestroy() {
    this.job?.stop();
  }

  private async run(organizationId: string) {
    try {
      const result = await this.tenants.sync(organizationId);
      this.logger.log({ event: 'propertyware_tenant_sync_finished', ...result });
    } catch (error) {
      // Logged and swallowed: a failed tenancy sync leaves yesterday's rows in
      // place, which is a stale list rather than a broken one, and throwing
      // here would only kill the cron tick.
      this.logger.error({
        event: 'propertyware_tenant_sync_failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
