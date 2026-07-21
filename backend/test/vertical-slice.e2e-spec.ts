import { VersioningType, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
// Supertest exposes a CommonJS callable; this form preserves that runtime shape under ts-jest.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import request = require('supertest');

import { AppModule } from '../src/app.module';
import { ApplicationExceptionFilter } from '../src/common/errors';

const admin = { 'x-mock-user-id': '10000000-0000-4000-8000-000000000003' };
const technician = { 'x-mock-user-id': '10000000-0000-4000-8000-000000000004' };
const reviewer = { 'x-mock-user-id': '10000000-0000-4000-8000-000000000005' };

describe('mock vertical slice (e2e)', () => {
  let app: INestApplication;
  const previousProvider = process.env.PROPERTYWARE_PROVIDER;
  const previousStore = process.env.PROPERTYWARE_STORE;
  beforeAll(async () => {
    process.env.USE_MOCK_AUTH = 'true';
    process.env.PROPERTYWARE_PROVIDER = 'mock';
    process.env.PROPERTYWARE_STORE = 'memory';
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new ApplicationExceptionFilter());
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
    if (previousProvider === undefined) delete process.env.PROPERTYWARE_PROVIDER;
    else process.env.PROPERTYWARE_PROVIDER = previousProvider;
    if (previousStore === undefined) delete process.env.PROPERTYWARE_STORE;
    else process.env.PROPERTYWARE_STORE = previousStore;
  });

  it('creates property through finding approval with validated human review', async () => {
    const property = await request(app.getHttpServer())
      .post('/api/v1/properties')
      .set(admin)
      .send({
        name: 'Vertical Slice House',
        addressLine1: '12 Mock Lane',
        city: 'Austin',
        state: 'TX',
        postalCode: '78701',
      })
      .expect(201);
    const floorPlan = await request(app.getHttpServer())
      .post(`/api/v1/properties/${property.body.id}/floor-plans`)
      .set(admin)
      .send({ fileName: 'plan.pdf', mimeType: 'application/pdf', sizeBytes: 2000 })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/floor-plans/${floorPlan.body.id}/extraction-jobs`)
      .set(admin)
      .send({})
      .expect(201);
    const areas = await request(app.getHttpServer())
      .get(`/api/v1/properties/${property.body.id}/areas`)
      .set(admin)
      .expect(200);
    const bedroom = areas.body.find((area: { name: string }) => area.name === 'Bedroom 1');
    await request(app.getHttpServer())
      .patch(`/api/v1/property-areas/${bedroom.id}`)
      .set(admin)
      .send({ name: 'Bedroom 1', isRequired: true })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/api/v1/properties/${property.body.id}/areas/approve`)
      .set(admin)
      .send({})
      .expect(201);
    const inspection = await request(app.getHttpServer())
      .post('/api/v1/inspections')
      .set(admin)
      .send({
        propertyId: property.body.id,
        technicianId: '10000000-0000-4000-8000-000000000004',
        scheduledAt: '2026-07-20T15:00:00Z',
      })
      .expect(201);
    const inspectionBedroom = inspection.body.areas.find(
      (area: { name: string }) => area.name === 'Bedroom 1',
    );
    const session = await request(app.getHttpServer())
      .post(`/api/v1/inspection-areas/${inspectionBedroom.id}/media/upload-session`)
      .set(technician)
      .send({ idempotencyKey: 'e2e-bedroom-video', fileName: 'bedroom.mp4', mimeType: 'video/mp4' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/inspection-areas/${inspectionBedroom.id}/media`)
      .set(technician)
      .send({
        providerUploadId: session.body.providerUploadId,
        providerMediaId: 'e2e-media',
        mimeType: 'video/mp4',
        durationSeconds: 37,
      })
      .expect(201);
    const findings = await request(app.getHttpServer())
      .get(`/api/v1/inspections/${inspection.body.id}/findings`)
      .set(reviewer)
      .expect(200);
    expect(findings.body[0].reviewStatus).toBe('PENDING_REVIEW');
    await request(app.getHttpServer())
      .post(`/api/v1/findings/${findings.body[0].id}/approve`)
      .set(reviewer)
      .send({})
      .expect(201)
      .expect(({ body }) => expect(body.reviewStatus).toBe('APPROVED'));
  });

  it('rejects unauthorized room-tag approval and missing review reasons', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/properties/20000000-0000-4000-8000-000000000001/areas/approve')
      .set(technician)
      .send({})
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/v1/findings/00000000-0000-4000-8000-000000000000/reject')
      .set(reviewer)
      .send({})
      .expect(400);
  });

  it('queues an admin-only Propertyware sync and exposes normalized active catalog data', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/integrations/propertyware/sync')
      .set(technician)
      .send({ entities: ['portfolios', 'buildings', 'units', 'leases'] })
      .expect(403);
    const queued = await request(app.getHttpServer())
      .post('/api/v1/integrations/propertyware/sync')
      .set(admin)
      .send({ mode: 'initial', entities: ['portfolios', 'buildings', 'units', 'leases'] })
      .expect(202);
    expect(queued.body.syncRunId).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const portfolios = await request(app.getHttpServer())
      .get('/api/v1/portfolios')
      .set(admin)
      .expect(200);
    expect(portfolios.body.items[0]).toMatchObject({ externalId: '91001', isActive: true });
    const properties = await request(app.getHttpServer())
      .get('/api/v1/properties')
      .set(admin)
      .expect(200);
    expect(properties.body.items[0]).toMatchObject({ externalId: '93001', isActive: true });
    const units = await request(app.getHttpServer())
      .get(`/api/v1/properties/${properties.body.items[0].id}/units`)
      .set(admin)
      .expect(200);
    expect(units.body.items[0]).toMatchObject({ externalId: '94001', isActive: true });
    const leases = await request(app.getHttpServer())
      .get(`/api/v1/units/${units.body.items[0].id}/leases`)
      .set(admin)
      .expect(200);
    expect(leases.body.items[0]).toMatchObject({ externalId: '95001', isActive: true });
  });
});
