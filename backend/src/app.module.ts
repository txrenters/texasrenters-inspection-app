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
import { HealthController } from './health/health.controller';
import { PropertywareModule } from './integrations/propertyware/propertyware.module';
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
import { WebhooksController } from './webhooks/webhooks.controller';

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
    RealtimeModule,
  ],
  controllers: [HealthController, VerticalSliceController, WebhooksController],
  providers: [
    VerticalSliceService,
    { provide: APP_INTERCEPTOR, useClass: RequestPerformanceInterceptor },
    ApiAuthGuard,
    RolesGuard,
    MockFloorPlanExtractionProvider,
    MockVideoPlatformProvider,
    MockTranscriptionProvider,
    MockAiAnalysisProvider,
    InMemoryJobQueueProvider,
    LocalDevelopmentFloorPlanStorageProvider,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
