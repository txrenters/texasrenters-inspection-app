// BROKEN: this harness authenticates with `x-mock-user-id`, and the mock-auth
// bypass it depends on has been removed from ApiAuthGuard. Every request below
// now returns 401.
//
// Left in place rather than deleted because the endpoint list and the sampling
// logic are still worth having. Making it run again means signing in for real
// and sending a bearer token — a small job, but one that needs a seeded set of
// credentials this file cannot carry.
import { measure, percentile, round } from './perf-utils.mjs';

const baseUrl = (process.env.PERF_API_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const sampleCount = Number(process.env.PERF_SAMPLES ?? 12);
const bearerToken = process.env.PERF_BEARER_TOKEN;
const mockAdmin = process.env.PERF_MOCK_ADMIN_ID ?? '10000000-0000-4000-8000-000000000003';
const mockTechnician =
  process.env.PERF_MOCK_TECHNICIAN_ID ?? '10000000-0000-4000-8000-000000000004';

const endpoints = [
  { name: 'health', path: '/api/v1/health', public: true },
  { name: 'databaseHealth', path: '/api/v1/health/database', public: true },
  { name: 'dashboard', path: '/api/v1/admin/dashboard', mockUser: mockAdmin },
  {
    name: 'inspectionList',
    path: '/api/v1/admin/inspections?page=1&pageSize=20',
    mockUser: mockAdmin,
  },
  {
    name: 'propertyList',
    path: '/api/v1/admin/properties?page=1&pageSize=20',
    mockUser: mockAdmin,
  },
  {
    name: 'technicianList',
    path: '/api/v1/admin/technicians?page=1&pageSize=20',
    mockUser: mockAdmin,
  },
  {
    name: 'providerReadiness',
    path: '/api/v1/admin/integrations/providers/status',
    mockUser: mockAdmin,
  },
  {
    name: 'propertywareStatus',
    path: '/api/v1/admin/integrations/propertyware/status',
    mockUser: mockAdmin,
  },
  {
    name: 'propertySearch',
    path: '/api/v1/admin/properties?page=1&pageSize=20&search=main',
    mockUser: mockAdmin,
  },
  {
    name: 'assignedInspections',
    path: '/api/v1/technician/inspections?page=1&pageSize=25',
    mockUser: mockTechnician,
  },
  { name: 'mobileDashboard', path: '/api/v1/technician/dashboard', mockUser: mockTechnician },
  { name: 'catalogPortfolios', path: '/api/v1/portfolios?page=1&pageSize=25', mockUser: mockAdmin },
];

const protectedHeaders = bearerToken
  ? { authorization: `Bearer ${bearerToken}` }
  : { 'x-mock-user-id': mockAdmin };
try {
  const response = await fetch(`${baseUrl}/api/v1/admin/inspections?page=1&pageSize=1`, {
    headers: protectedHeaders,
  });
  if (response.ok) {
    const payload = await response.json();
    const id = payload?.items?.[0]?.id;
    if (typeof id === 'string') {
      endpoints.push({
        name: 'inspectionDetail',
        path: `/api/v1/admin/inspections/${encodeURIComponent(id)}`,
        mockUser: mockAdmin,
      });
      endpoints.push({
        name: 'inspectionAudit',
        path: `/api/v1/admin/inspections/${encodeURIComponent(id)}/audit?page=1&pageSize=20`,
        mockUser: mockAdmin,
      });
      endpoints.push({
        name: 'inspectionAssignments',
        path: `/api/v1/admin/assignments?inspectionId=${encodeURIComponent(id)}&includeUnassigned=false&page=1&pageSize=20`,
        mockUser: mockAdmin,
      });
    }
  }
} catch {
  // The list benchmark below reports connectivity or authorization failures safely.
}

try {
  const response = await fetch(`${baseUrl}/api/v1/admin/technicians?page=1&pageSize=1`, {
    headers: protectedHeaders,
  });
  if (response.ok) {
    const payload = await response.json();
    const id = payload?.items?.[0]?.id;
    if (typeof id === 'string') {
      endpoints.push({
        name: 'technicianDetail',
        path: `/api/v1/admin/technicians/${encodeURIComponent(id)}`,
        mockUser: mockAdmin,
      });
      endpoints.push({
        name: 'technicianAssignments',
        path: `/api/v1/admin/assignments?technicianId=${encodeURIComponent(id)}&page=1&pageSize=20`,
        mockUser: mockAdmin,
      });
    }
  }
} catch {
  // The technician-list benchmark below reports connectivity or authorization failures safely.
}

try {
  const response = await fetch(
    `${baseUrl}/api/v1/admin/integrations/propertyware/sync-runs?page=1&pageSize=1`,
    { headers: protectedHeaders },
  );
  if (response.ok) {
    const payload = await response.json();
    const id = payload?.items?.[0]?.id;
    if (typeof id === 'string')
      endpoints.push({
        name: 'syncErrors',
        path: `/api/v1/admin/integrations/propertyware/sync-runs/${encodeURIComponent(id)}/errors?page=1&pageSize=25`,
        mockUser: mockAdmin,
      });
  }
} catch {
  // The sync page can be absent in an empty development database.
}

try {
  const response = await fetch(`${baseUrl}/api/v1/admin/properties?page=1&pageSize=1`, {
    headers: protectedHeaders,
  });
  if (response.ok) {
    const payload = await response.json();
    const id = payload?.items?.[0]?.id;
    if (typeof id === 'string')
      endpoints.push({
        name: 'propertyDetail',
        path: `/api/v1/admin/properties/${encodeURIComponent(id)}`,
        mockUser: mockAdmin,
      });
  }
} catch {
  // The list benchmark below reports connectivity or authorization failures safely.
}

const technicianHeaders = bearerToken
  ? { authorization: `Bearer ${bearerToken}` }
  : { 'x-mock-user-id': mockTechnician };
try {
  const response = await fetch(`${baseUrl}/api/v1/technician/inspections?page=1&pageSize=1`, {
    headers: technicianHeaders,
  });
  if (response.ok) {
    const payload = await response.json();
    const id = payload?.items?.[0]?.id;
    if (typeof id === 'string')
      endpoints.push({
        name: 'mobileInspectionContext',
        path: `/api/v1/technician/inspections/${encodeURIComponent(id)}/context`,
        mockUser: mockTechnician,
      });
  }
} catch {
  // The assigned-inspections benchmark below reports connectivity failures safely.
}

const report = { generatedAt: new Date().toISOString(), baseUrl, measurements: {} };
for (const endpoint of endpoints) {
  const headers = endpoint.public
    ? {}
    : bearerToken
      ? { authorization: `Bearer ${bearerToken}` }
      : { 'x-mock-user-id': endpoint.mockUser };
  try {
    let payloadBytes = 0;
    let status = 0;
    let serverTiming = null;
    let queryCount = null;
    const queryCounts = [];
    const databaseDurations = [];
    const result = await measure(async () => {
      const response = await fetch(`${baseUrl}${endpoint.path}`, { headers });
      const body = await response.arrayBuffer();
      status = response.status;
      payloadBytes = body.byteLength;
      serverTiming = response.headers.get('server-timing');
      queryCount = response.headers.get('x-database-query-count');
      queryCounts.push(queryCount === null ? 0 : Number(queryCount));
      const databaseMatch = serverTiming?.match(/db;dur=([\d.]+)/);
      databaseDurations.push(databaseMatch ? Number(databaseMatch[1]) : 0);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    }, sampleCount);
    report.measurements[endpoint.name] = {
      ...result.summary,
      status,
      payloadBytes,
      queryCount: queryCount === null ? null : Number(queryCount),
      coldQueryCount: queryCounts[0] ?? null,
      warmMedianQueryCount: queryCounts.length ? percentile(queryCounts.slice(1), 0.5) : null,
      coldDatabaseMs: round(databaseDurations[0] ?? 0),
      warmMedianDatabaseMs: round(percentile(databaseDurations.slice(1), 0.5)),
      serverTiming,
    };
  } catch (error) {
    report.measurements[endpoint.name] = {
      skipped: error instanceof Error ? error.message : 'Request failed.',
    };
  }
}

console.log(JSON.stringify(report, null, 2));
