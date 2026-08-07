import type { MiddlewareConsumer } from '@nestjs/common';
import { Module, type NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';

import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { CacheModule } from './cache/cache.module';
import { ApiAuthGuard, RolesGuard } from './common/auth';
import { RequestIdMiddleware } from './common/request-id.middleware';
import { RequestPerformanceInterceptor } from './common/request-performance.interceptor';
import { validateEnvironment } from './config/environment';
import { DatabaseModule } from './database/database.module';
import { TenantScopeInterceptor } from './database/tenant-scope.interceptor';
import { HealthController } from './health/health.controller';
import { PropertywareModule } from './integrations/propertyware/propertyware.module';
import { MediaModule } from './media/media.module';
import { TechnicianModule } from './technician/technician.module';
import { RealtimeModule } from './realtime/realtime.module';
import {
  InMemoryJobQueueProvider,
  LocalDevelopmentFloorPlanStorageProvider,
  MockAiAnalysisProvider,
  MockFloorPlanExtractionProvider,
  MockTranscriptionProvider,
  MockVideoPlatformProvider,
} from './providers/mock.providers';
import { VerticalSliceController } from './vertical-slice/vertical-slice.controller';
import { VerticalSliceService } from './vertical-slice/vertical-slice.service';
import { WebhookSignatureGuard } from './webhooks/webhook-signature.guard';
import { WebhooksController } from './webhooks/webhooks.controller';

// The in-memory vertical-slice stack (seeded demo data, mock providers, and
// their webhook endpoints) exists for development and demos only. Production
// serves exclusively the database-backed admin/technician modules.
const isProduction = process.env.NODE_ENV === 'production';
const mockStackControllers = isProduction ? [] : [VerticalSliceController, WebhooksController];
const mockStackProviders = isProduction
  ? []
  : [
      VerticalSliceService,
      WebhookSignatureGuard,
      MockFloorPlanExtractionProvider,
      MockVideoPlatformProvider,
      MockTranscriptionProvider,
      MockAiAnalysisProvider,
      InMemoryJobQueueProvider,
      LocalDevelopmentFloorPlanStorageProvider,
    ];

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      validate: validateEnvironment,
    }),
    DatabaseModule,
    CacheModule,
    AdminModule,
    AuthModule,
    PropertywareModule,
    TechnicianModule,
    MediaModule,
    RealtimeModule,
  ],
  controllers: [HealthController, ...mockStackControllers],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: RequestPerformanceInterceptor },
    // Global, so a new controller is scoped without anyone remembering to opt
    // in. Runs after the guards, which is what makes request.user available.
    { provide: APP_INTERCEPTOR, useClass: TenantScopeInterceptor },
    ApiAuthGuard,
    RolesGuard,
    ...mockStackProviders,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
