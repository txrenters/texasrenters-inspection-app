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
import { GatewayModule } from './gateway/gateway.module';
import { TenantScopeInterceptor } from './database/tenant-scope.interceptor';
import { HealthController } from './health/health.controller';
import { JobberModule } from './integrations/jobber/jobber.module';
import { PropertywareModule } from './integrations/propertyware/propertyware.module';
import { MediaModule } from './media/media.module';
import { OpenApiModule } from './openapi/openapi.module';
import { TechnicianModule } from './technician/technician.module';
import { RealtimeModule } from './realtime/realtime.module';

// The in-memory vertical-slice stack — seeded demo data, mock transcription and
// analysis providers, and their own webhook endpoints — used to be registered
// here whenever NODE_ENV was not 'production'. It is gone.
//
// It was scaffolding that outlived the scaffold. Every real path now runs on
// the database-backed admin/technician modules and on providers resolved from
// AiProviderSettings, so the mock stack was reachable only by NODE_ENV, which
// is exactly the kind of switch that produces convincing fabricated findings on
// a laptop and silence in production. A missing provider must fail loudly.

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
    JobberModule,
    TechnicianModule,
    MediaModule,
    RealtimeModule,
    OpenApiModule,
    GatewayModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: RequestPerformanceInterceptor },
    // Global, so a new controller is scoped without anyone remembering to opt
    // in. Runs after the guards, which is what makes request.user available.
    { provide: APP_INTERCEPTOR, useClass: TenantScopeInterceptor },
    ApiAuthGuard,
    RolesGuard,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
