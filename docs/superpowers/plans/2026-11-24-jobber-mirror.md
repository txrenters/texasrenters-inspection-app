# Jobber Mirror Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a read-only copy of every Jobber client, property, job, visit, quote and request — with their notes, visit Details and note attachments — in our database, current until Jobber is removed and kept as an archive after.

**Architecture:** One generic table `JobberRecord` holds each record's raw payload plus a few searchable columns; `JobberMirrorCursor` keeps each kind's place so a run can stop anywhere and resume; `JobberRecordFile` tracks attachments copied into our object storage. `JobberMirrorWorker` and `JobberMirrorFileWorker` run at the end of the existing `JobberSyncScheduler` tick, bounded per run and paced on Jobber's query-cost bucket, behind `JOBBER_MIRROR_ENABLED`.

**Tech Stack:** NestJS, Prisma 6.19 (PostgreSQL, RLS), Jest 29 + ts-jest, Jobber GraphQL via the existing `JobberClient`.

**Spec:** `docs/superpowers/specs/2026-11-24-jobber-mirror-design.md` (its "Revisions after reading the code" section wins where it disagrees with the rest).

## Global Constraints

- Read-only towards Jobber: no mutation is ever sent by mirror code.
- Off unless `JOBBER_MIRROR_ENABLED` is exactly `"true"`; nothing runs on a laptop by default.
- Invoices and payments are **not** mirrored again (already copied by `JobberInvoiceWorker`).
- Every row carries `organizationId`; every new table gets the `tenant_isolation` RLS policy; every background call runs inside `withTenant` (the scheduler already wraps).
- Nothing is ever deleted from the mirror: a record gone from Jobber gets `deletedInJobberAt`.
- No Jobber token, file URL or secret is stored in mirror tables or logged.
- Per run: at most 40 pages and 90 seconds for records; at most 5 records' attachments, 15 files, 60 seconds for files; files capped per business day by `JOBBER_MIRROR_FILE_DAILY_CEILING` (default 2000).
- Laptop: run only the named spec files (`npx jest test/<file>`), never the whole suite; no Docker.
- Migrations are append-only: a new folder, plus its hash in `prisma/migrations/applied.lock.json`.
- All commands run from `backend/`.

## Review Focus

1. **Jobber hides records mid-walk** (a permission change returns fewer records): marking everything unseen as deleted would wipe the archive's live view. Expected: a walk that saw fewer than half the live rows marks nothing and records `WALK_SHORT`. → test in Task 4.
2. **A job/client/quote/request with more notes or quote lines than a page carries**: expected the full set, read again by itself. → test in Task 4.
3. **The bucket is empty (THROTTLED) halfway through the kinds**: expected the run stops cleanly, keeps every cursor, and the next tick resumes the same kind. → test in Task 4.
4. **A record that disappeared and came back** (restored in Jobber): expected `deletedInJobberAt` cleared on the next sighting. → test in Task 4 (store).
5. **An attachment whose parent is gone from Jobber**: expected its pending files end as failed with a reason, never retried forever. → test in Task 5.

---

## File map

| File | Responsibility |
|---|---|
| `backend/scripts/jobber-mirror-probe.ts` (create) | One-off introspection of the live schema for the kinds' field names and filters |
| `backend/prisma/schema.prisma` (modify) | `JobberRecordKind` enum, `JobberRecord`, `JobberRecordFile`, `JobberMirrorCursor`, back-relations on `Organization` |
| `backend/prisma/migrations/202611250001_jobber_mirror/migration.sql` (create) | Tables, indexes, FKs, RLS |
| `backend/prisma/migrations/applied.lock.json` (modify) | Hash of the new migration |
| `backend/src/config/environment.ts`, `src/integrations/jobber/jobber.types.ts`, `src/integrations/jobber/jobber.config.ts` (modify) | `JOBBER_MIRROR_ENABLED` → `config.mirrorEnabled` |
| `backend/src/integrations/jobber/jobber-mirror.kinds.ts` (create) | What each kind is: GraphQL selection, queries, summary columns, cut-short detection |
| `backend/src/integrations/jobber/jobber-mirror.store.ts` (create) | Writing a page of records + its cursor in one transaction; marking unseen as deleted |
| `backend/src/workers/jobber-sync/jobber-mirror.worker.ts` (create) | The bounded run: which kind, walk or changes, paging, pacing, failures |
| `backend/src/workers/jobber-sync/jobber-mirror-files.worker.ts` (create) | Listing and copying note attachments |
| `backend/src/integrations/jobber/jobber-mirror.service.ts` (create) | Status for the console; marking a visit deleted from the webhook |
| `jobber.module.ts`, `jobber-sync.scheduler.ts`, `jobber.controller.ts`, `jobber.webhook.service.ts` (modify) | Wiring |
| `backend/test/jobber-mirror-*.spec.ts` (create) | Tests |

---

### Task 1: Probe the live schema

The selections in Task 3 follow Jobber's published types, but only `visits`, `invoices` and `noteAttachments` are proven against this account's pinned `JOBBER_API_VERSION`. An unknown field fails a whole query, so this is checked first, on the server, with one cheap introspection request.

**Files:**
- Create: `backend/scripts/jobber-mirror-probe.ts`

**Interfaces:**
- Consumes: `JobberClient.request(organizationId, query, variables)` (existing), `withTenant` (existing), `AppModule`.
- Produces: a printed report used to correct Task 3's `MIRROR_KINDS` selections.

- [ ] **Step 1: Write the probe**

```ts
/**
 * One-off: prints the fields and filters Jobber's live schema has for every
 * kind the mirror reads, so the mirror's selections can be checked before any
 * of them is sent (2026-11-24). Introspection only -- reads no records.
 *
 *   node --env-file-if-exists=.env -r ts-node/register/transpile-only scripts/jobber-mirror-probe.ts
 */
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../src/app.module';
import { withTenant } from '../src/database/tenant-context';
import { JobberClient } from '../src/integrations/jobber/jobber.client';

interface TypeRef { name: string | null; kind: string; ofType?: TypeRef | null }
interface Field { name: string; type: TypeRef; args?: { name: string; type: TypeRef }[] }

const TYPE_REF = 'name kind ofType { name kind ofType { name kind ofType { name kind } } }';
const named = (type: TypeRef | null | undefined): string | null => (type ? (type.name ?? named(type.ofType)) : null);

const ROOTS = ['clients', 'properties', 'jobs', 'visits', 'quotes', 'requests'];
const TYPES = ['Client', 'Property', 'Job', 'Visit', 'Quote', 'Request'];

async function main() {
  const organizationId = process.env.JOBBER_LOCAL_ORGANIZATION_ID;
  if (!organizationId) throw new Error('Set JOBBER_LOCAL_ORGANIZATION_ID.');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  const client = app.get(JobberClient);
  const ask = <T>(query: string) => withTenant(organizationId, () => client.request<T>(organizationId, query, {}));

  const root = await ask<{ __type: { fields: Field[] } }>(
    `query { __type(name: "Query") { fields { name args { name type { ${TYPE_REF} } } } } }`,
  );
  const inputs = new Set<string>();
  for (const field of root.__type.fields.filter((f) => ROOTS.includes(f.name))) {
    const filter = field.args?.find((a) => a.name === 'filter');
    console.log(`\nQuery.${field.name}(${field.args?.map((a) => a.name).join(', ')}) filter: ${named(filter?.type)}`);
    if (filter) inputs.add(named(filter.type)!);
  }
  for (const input of inputs) {
    const data = await ask<{ __type: { inputFields: { name: string }[] } }>(
      `query { __type(name: "${input}") { inputFields { name } } }`,
    );
    console.log(`${input}: ${data.__type.inputFields.map((f) => f.name).join(', ')}`);
  }
  for (const type of TYPES) {
    const data = await ask<{ __type: { fields: Field[] } }>(`query { __type(name: "${type}") { fields { name type { ${TYPE_REF} } } } }`);
    console.log(`\n${type}: ${data.__type.fields.map((f) => `${f.name}:${named(f.type)}`).join(' ')}`);
    for (const connection of data.__type.fields.filter((f) => ['notes', 'noteAttachments'].includes(f.name))) {
      const conn = await ask<{ __type: { fields: Field[] } }>(`query { __type(name: "${named(connection.type)}") { fields { name type { ${TYPE_REF} } } } }`);
      const node = named(conn.__type.fields.find((f) => f.name === 'nodes')?.type);
      const shape = await ask<{ __type: { possibleTypes: { name: string }[] | null; fields: { name: string }[] | null } }>(
        `query { __type(name: "${node}") { possibleTypes { name } fields { name } } }`,
      );
      console.log(`  ${type}.${connection.name} -> ${node}: types [${shape.__type.possibleTypes?.map((t) => t.name).join(', ') ?? '-'}] fields [${shape.__type.fields?.map((f) => f.name).join(', ') ?? '-'}]`);
      for (const member of shape.__type.possibleTypes ?? []) {
        const m = await ask<{ __type: { fields: { name: string }[] } }>(`query { __type(name: "${member.name}") { fields { name } } }`);
        console.log(`    ${member.name}: ${m.__type.fields.map((f) => f.name).join(', ')}`);
      }
    }
  }
  await app.close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
```

- [ ] **Step 2: Type-check it**

Run: `npx tsc --noEmit -p tsconfig.json scripts/jobber-mirror-probe.ts` — if the project's tsconfig does not include `scripts/`, run `npx tsc --noEmit --esModuleInterop --experimentalDecorators --emitDecoratorMetadata --skipLibCheck --target es2022 --module commonjs scripts/jobber-mirror-probe.ts`.
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add scripts/jobber-mirror-probe.ts
git commit -m "chore(jobber): a probe that prints the live schema's fields for every kind the mirror will read"
```

- [ ] **Step 4: STOP — the office runs it on the server**

Ask the user to run, on the server (not the laptop):
`node --env-file-if-exists=.env -r ts-node/register/transpile-only scripts/jobber-mirror-probe.ts`
and paste the output. Record it at the bottom of this plan under **Probe result**. Every field name in Task 3's `MIRROR_KINDS` that the output does not list is removed or renamed to the one it does list; each `changes` value is set to `'updatedAt'` only if that root's filter input lists `updatedAt`, otherwise `null`. Do not start Task 3 until this is done.

---

### Task 2: Tables, migration and the switch

**Files:**
- Modify: `backend/prisma/schema.prisma` (new enum + 3 models after `model JobberVisitImport`; 3 relation lines in `model Organization` next to `jobberVisitImports`)
- Create: `backend/prisma/migrations/202611250001_jobber_mirror/migration.sql`
- Modify: `backend/prisma/migrations/applied.lock.json`
- Modify: `backend/src/config/environment.ts` (next to `JOBBER_SYNC_ENABLED`, line ~199)
- Modify: `backend/src/integrations/jobber/jobber.types.ts` (`JobberConfig`)
- Modify: `backend/src/integrations/jobber/jobber.config.ts` (`getJobberConfig`)
- Test: `backend/test/jobber-mirror-config.spec.ts`

**Interfaces:**
- Produces: Prisma models `jobberRecord`, `jobberRecordFile`, `jobberMirrorCursor`; enum `JobberRecordKind { CLIENT PROPERTY JOB VISIT QUOTE REQUEST }`; unique inputs `organizationId_kind_jobberId`, `organizationId_kind`, `organizationId_jobberFileId`; `JobberConfig.mirrorEnabled: boolean`.

- [ ] **Step 1: Write the failing test**

`backend/test/jobber-mirror-config.spec.ts`:

```ts
import { getJobberConfig } from '../src/integrations/jobber/jobber.config';

describe('the mirror switch', () => {
  it('is off unless JOBBER_MIRROR_ENABLED is exactly "true"', () => {
    expect(getJobberConfig({}).mirrorEnabled).toBe(false);
    expect(getJobberConfig({ JOBBER_MIRROR_ENABLED: 'TRUE' }).mirrorEnabled).toBe(false);
    expect(getJobberConfig({ JOBBER_MIRROR_ENABLED: 'true' }).mirrorEnabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx jest test/jobber-mirror-config.spec.ts`
Expected: FAIL — `mirrorEnabled` is `undefined`.

- [ ] **Step 3: Add the switch**

`jobber.types.ts`, in `JobberConfig` after `syncEnabled: boolean;`:

```ts
  /** The read-only copy of every Jobber record (2026-11-24). Off unless "true". */
  mirrorEnabled: boolean;
```

`jobber.config.ts`, after the `syncEnabled:` line:

```ts
    // Fail closed, like the sync: a typo leaves the mirror off.
    mirrorEnabled: env.JOBBER_MIRROR_ENABLED === 'true',
```

`environment.ts`, after the `JOBBER_SYNC_ENABLED` line:

```ts
    JOBBER_MIRROR_ENABLED: z.enum(['true', 'false']).default('false'),
    JOBBER_MIRROR_FILE_DAILY_CEILING: z.coerce.number().int().min(0).optional(),
```

- [ ] **Step 4: Run it to see it pass**

Run: `npx jest test/jobber-mirror-config.spec.ts`
Expected: PASS.

- [ ] **Step 5: Add the models**

In `schema.prisma`, after `model JobberVisitImport { ... }`:

```prisma
/// What a mirrored Jobber record is (2026-11-24).
enum JobberRecordKind {
  CLIENT
  PROPERTY
  JOB
  VISIT
  QUOTE
  REQUEST
}

/// One Jobber record, kept as Jobber sent it, so nothing is lost when the
/// office closes the Jobber account (2026-11-24).
///
/// Read-only: nothing here is ever sent back. The columns beside `payload` are
/// only for finding a record; `payload` is the record. Notes travel inside
/// their parent's payload, a visit's Details are its `instructions`.
model JobberRecord {
  id                String           @id @default(uuid()) @db.Uuid
  organizationId    String           @db.Uuid
  kind              JobberRecordKind
  jobberId          String
  payload           Json
  number            String?
  title             String?
  clientJobberId    String?
  propertyJobberId  String?
  jobJobberId       String?
  address           String?
  occursAt          DateTime?
  status            String?
  jobberCreatedAt   DateTime?
  /// Null for kinds Jobber gives no update time (visits, properties).
  jobberUpdatedAt   DateTime?
  /// The payload saved, but the columns above could not be read from it.
  extractFailed     Boolean          @default(false)
  /// Note attachments Jobber reports on the record, and when they were last listed.
  fileCount         Int              @default(0)
  filesListedAt     DateTime?
  /// Stamped every time a read returns the record; a full walk that ends marks
  /// rows it did not see as deleted.
  lastSeenAt        DateTime
  /// Gone from Jobber. Never erased; cleared if the record comes back.
  deletedInJobberAt DateTime?
  createdAt         DateTime         @default(now())
  updatedAt         DateTime         @updatedAt
  organization      Organization     @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  files             JobberRecordFile[]

  @@unique([organizationId, kind, jobberId])
  @@index([organizationId, kind, occursAt])
  @@index([organizationId, kind, number])
  @@index([organizationId, clientJobberId])
  @@index([organizationId, jobJobberId])
  @@index([organizationId, kind, lastSeenAt])
}

/// A note attachment on a mirrored record, copied into our storage because
/// Jobber's links stop working with the account (2026-11-24). Jobber's URL is
/// never stored: it is asked for again when the file is copied.
model JobberRecordFile {
  id              String       @id @default(uuid()) @db.Uuid
  organizationId  String       @db.Uuid
  recordId        String       @db.Uuid
  jobberFileId    String
  fileName        String?
  contentType     String?
  sizeBytes       Int?
  storageKey      String?
  copyAttempts    Int          @default(0)
  copyAttemptedAt DateTime?
  copyProblem     String?
  copiedAt        DateTime?
  createdAt       DateTime     @default(now())
  updatedAt       DateTime     @updatedAt
  organization    Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  record          JobberRecord @relation(fields: [recordId], references: [id], onDelete: Cascade)

  @@unique([organizationId, jobberFileId])
  @@index([recordId])
  @@index([organizationId, storageKey])
}

/// Where the mirror is in each kind, so a run can stop anywhere and the next
/// carries on (2026-11-24). A "walk" reads every record; "changes" reads what
/// changed since (`updatedAt`), or, for visits, a window of dates.
model JobberMirrorCursor {
  id                 String           @id @default(uuid()) @db.Uuid
  organizationId     String           @db.Uuid
  kind               JobberRecordKind
  walkCursor         String?
  walkStartedAt      DateTime?
  walkCompletedAt    DateTime?
  walkSeen           Int              @default(0)
  changesCursor      String?
  changesStartedAt   DateTime?
  changesCompletedAt DateTime?
  changesSince       DateTime?
  lastCheckedAt      DateTime?
  lastError          String?
  lastErrorAt        DateTime?
  createdAt          DateTime         @default(now())
  updatedAt          DateTime         @updatedAt
  organization       Organization     @relation(fields: [organizationId], references: [id], onDelete: Cascade)

  @@unique([organizationId, kind])
}
```

In `model Organization`, next to `jobberVisitImports   JobberVisitImport[]`:

```prisma
  jobberRecords        JobberRecord[]
  jobberRecordFiles    JobberRecordFile[]
  jobberMirrorCursors  JobberMirrorCursor[]
```

- [ ] **Step 6: Write the migration**

`backend/prisma/migrations/202611250001_jobber_mirror/migration.sql`:

```sql
-- A read-only copy of every Jobber record, kept until and after Jobber is
-- removed (2026-11-24).

CREATE TYPE "JobberRecordKind" AS ENUM ('CLIENT', 'PROPERTY', 'JOB', 'VISIT', 'QUOTE', 'REQUEST');

CREATE TABLE "JobberRecord" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "kind" "JobberRecordKind" NOT NULL,
  "jobberId" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "number" TEXT,
  "title" TEXT,
  "clientJobberId" TEXT,
  "propertyJobberId" TEXT,
  "jobJobberId" TEXT,
  "address" TEXT,
  "occursAt" TIMESTAMP(3),
  "status" TEXT,
  "jobberCreatedAt" TIMESTAMP(3),
  "jobberUpdatedAt" TIMESTAMP(3),
  "extractFailed" BOOLEAN NOT NULL DEFAULT false,
  "fileCount" INTEGER NOT NULL DEFAULT 0,
  "filesListedAt" TIMESTAMP(3),
  "lastSeenAt" TIMESTAMP(3) NOT NULL,
  "deletedInJobberAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "JobberRecord_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "JobberRecord_organizationId_kind_jobberId_key" ON "JobberRecord"("organizationId", "kind", "jobberId");
CREATE INDEX "JobberRecord_organizationId_kind_occursAt_idx" ON "JobberRecord"("organizationId", "kind", "occursAt");
CREATE INDEX "JobberRecord_organizationId_kind_number_idx" ON "JobberRecord"("organizationId", "kind", "number");
CREATE INDEX "JobberRecord_organizationId_clientJobberId_idx" ON "JobberRecord"("organizationId", "clientJobberId");
CREATE INDEX "JobberRecord_organizationId_jobJobberId_idx" ON "JobberRecord"("organizationId", "jobJobberId");
CREATE INDEX "JobberRecord_organizationId_kind_lastSeenAt_idx" ON "JobberRecord"("organizationId", "kind", "lastSeenAt");

ALTER TABLE "JobberRecord" ADD CONSTRAINT "JobberRecord_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "JobberRecordFile" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "recordId" UUID NOT NULL,
  "jobberFileId" TEXT NOT NULL,
  "fileName" TEXT,
  "contentType" TEXT,
  "sizeBytes" INTEGER,
  "storageKey" TEXT,
  "copyAttempts" INTEGER NOT NULL DEFAULT 0,
  "copyAttemptedAt" TIMESTAMP(3),
  "copyProblem" TEXT,
  "copiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "JobberRecordFile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "JobberRecordFile_organizationId_jobberFileId_key" ON "JobberRecordFile"("organizationId", "jobberFileId");
CREATE INDEX "JobberRecordFile_recordId_idx" ON "JobberRecordFile"("recordId");
CREATE INDEX "JobberRecordFile_organizationId_storageKey_idx" ON "JobberRecordFile"("organizationId", "storageKey");

ALTER TABLE "JobberRecordFile" ADD CONSTRAINT "JobberRecordFile_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "JobberRecordFile" ADD CONSTRAINT "JobberRecordFile_recordId_fkey"
  FOREIGN KEY ("recordId") REFERENCES "JobberRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "JobberMirrorCursor" (
  "id" UUID NOT NULL,
  "organizationId" UUID NOT NULL,
  "kind" "JobberRecordKind" NOT NULL,
  "walkCursor" TEXT,
  "walkStartedAt" TIMESTAMP(3),
  "walkCompletedAt" TIMESTAMP(3),
  "walkSeen" INTEGER NOT NULL DEFAULT 0,
  "changesCursor" TEXT,
  "changesStartedAt" TIMESTAMP(3),
  "changesCompletedAt" TIMESTAMP(3),
  "changesSince" TIMESTAMP(3),
  "lastCheckedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "lastErrorAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "JobberMirrorCursor_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "JobberMirrorCursor_organizationId_kind_key" ON "JobberMirrorCursor"("organizationId", "kind");

ALTER TABLE "JobberMirrorCursor" ADD CONSTRAINT "JobberMirrorCursor_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "JobberRecord" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "JobberRecord"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );

ALTER TABLE "JobberRecordFile" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "JobberRecordFile"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );

ALTER TABLE "JobberMirrorCursor" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "JobberMirrorCursor"
  USING (
    current_setting('app.organization_id', true) = '*'
    OR "organizationId"::text = current_setting('app.organization_id', true)
  );
```

- [ ] **Step 7: Record the migration's hash**

Run:
```bash
node -e "const c=require('crypto'),f=require('fs');console.log(c.createHash('sha256').update(f.readFileSync('prisma/migrations/202611250001_jobber_mirror/migration.sql','utf8').split('\r').join('')).digest('hex').slice(0,16))"
```
Add `"202611250001_jobber_mirror": "<printed hash>"` as the last entry of `prisma/migrations/applied.lock.json`.

- [ ] **Step 8: Validate and generate**

Run: `npx prisma validate && npx prisma generate && npx jest test/migrations-append-only.spec.ts test/jobber-mirror-config.spec.ts`
Expected: schema valid, client generated, both specs PASS. If the portable Postgres is running, also `npx prisma migrate deploy` and expect `202611250001_jobber_mirror` applied.

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/202611250001_jobber_mirror prisma/migrations/applied.lock.json src/config/environment.ts src/integrations/jobber/jobber.types.ts src/integrations/jobber/jobber.config.ts test/jobber-mirror-config.spec.ts
git commit -m "feat(jobber): tables for a read-only copy of every Jobber record, off unless JOBBER_MIRROR_ENABLED"
```

---

### Task 3: The kinds — queries and summaries

**Files:**
- Create: `backend/src/integrations/jobber/jobber-mirror.kinds.ts`
- Test: `backend/test/jobber-mirror-kinds.spec.ts`

**Interfaces:**
- Consumes: `VISIT_DETAILS_FIELD` from `jobber.queries.ts`; `JobberRecordKind` from `@prisma/client`.
- Produces:
  - `interface MirrorKind { kind: JobberRecordKind; connection: string; single: string | null; pageSize: number; changes: 'updatedAt' | 'startAtWindow' | null; hasFiles: boolean; select(limits: NestedLimits): string }`
  - `interface NestedLimits { notes: number; lines: number }`, `PAGE_LIMITS`, `ALONE_LIMITS`
  - `MIRROR_KINDS: readonly MirrorKind[]` in run order CLIENT, PROPERTY, JOB, VISIT, QUOTE, REQUEST
  - `mirrorKind(kind): MirrorKind`
  - `mirrorPageQuery(spec: MirrorKind, mode: 'walk' | 'changes'): string`
  - `mirrorOneQuery(spec: MirrorKind): string` (variables `{ id }`, root field `spec.single`)
  - `mirrorFilesQuery(spec: MirrorKind): string` (variables `{ id }`)
  - `interface RecordSummary { number; title; clientJobberId; propertyJobberId; jobJobberId; address; occursAt: Date | null; status; jobberCreatedAt: Date | null; jobberUpdatedAt: Date | null; fileCount: number }` (strings are `string | null`)
  - `summarize(kind, node: Record<string, unknown>): RecordSummary` — throws `TypeError` on a shape it cannot read
  - `isCutShort(node: Record<string, unknown>): boolean`

- [ ] **Step 1: Write the failing tests**

`backend/test/jobber-mirror-kinds.spec.ts`:

```ts
import { JobberRecordKind } from '@prisma/client';

import {
  isCutShort,
  MIRROR_KINDS,
  mirrorFilesQuery,
  mirrorKind,
  mirrorOneQuery,
  mirrorPageQuery,
  summarize,
} from '../src/integrations/jobber/jobber-mirror.kinds';

/** What each mirrored kind reads and how a record is found again (2026-11-24). Ids invented. */

describe('the kinds', () => {
  it('reads clients first and every kind once, never invoices', () => {
    expect(MIRROR_KINDS.map((k) => k.kind)).toEqual(['CLIENT', 'PROPERTY', 'JOB', 'VISIT', 'QUOTE', 'REQUEST']);
    expect(MIRROR_KINDS.map((k) => k.connection)).not.toContain('invoices');
  });

  it('asks for a page with first/after, and for changes with the filter the kind supports', () => {
    const jobs = mirrorKind(JobberRecordKind.JOB);
    expect(mirrorPageQuery(jobs, 'walk')).toMatch(/jobs\(first: \$first, after: \$after\s*\)/);
    expect(mirrorPageQuery(jobs, 'changes')).toContain('filter: { updatedAt: { after: $since } }');
    const visits = mirrorKind(JobberRecordKind.VISIT);
    expect(mirrorPageQuery(visits, 'changes')).toContain('filter: { startAt: { after: $from, before: $to } }');
    expect(mirrorPageQuery(visits, 'walk')).toContain('instructions');
  });

  it('carries notes on a page, more of them when a record is read by itself', () => {
    const jobs = mirrorKind(JobberRecordKind.JOB);
    expect(mirrorPageQuery(jobs, 'walk')).toContain('notes(first: 5)');
    expect(mirrorOneQuery(jobs)).toContain('notes(first: 50)');
    expect(mirrorOneQuery(jobs)).toMatch(/job\(id: \$id\)/);
  });

  it('lists attachments with the links the invoice copy already uses', () => {
    const query = mirrorFilesQuery(mirrorKind(JobberRecordKind.JOB));
    expect(query).toContain('noteAttachments(first: 100)');
    expect(query).toContain('downloadUrl');
  });
});

describe('summarize', () => {
  it('finds a job by its number, client, property, start and status', () => {
    const summary = summarize(JobberRecordKind.JOB, {
      id: 'job-1',
      jobNumber: 21127,
      title: 'General Maintenance - WO#44805',
      jobStatus: 'active',
      startAt: '2026-11-24T06:00:00Z',
      createdAt: '2026-11-20T10:00:00Z',
      updatedAt: '2026-11-23T10:00:00Z',
      client: { id: 'client-1', name: '3301 Omega B' },
      property: { id: 'prop-1', address: { street1: '3301 Omega B', street2: null, city: 'Houston', province: 'TX', postalCode: '77022' } },
      noteAttachments: { totalCount: 2 },
    });
    expect(summary).toEqual({
      number: '21127',
      title: 'General Maintenance - WO#44805',
      clientJobberId: 'client-1',
      propertyJobberId: 'prop-1',
      jobJobberId: null,
      address: '3301 Omega B, Houston, TX 77022',
      occursAt: new Date('2026-11-24T06:00:00Z'),
      status: 'active',
      jobberCreatedAt: new Date('2026-11-20T10:00:00Z'),
      jobberUpdatedAt: new Date('2026-11-23T10:00:00Z'),
      fileCount: 2,
    });
  });

  it('files a visit under its job, with no update time', () => {
    const summary = summarize(JobberRecordKind.VISIT, {
      id: 'visit-1',
      title: '3301 Omega B - Zone 1',
      startAt: '2026-11-24T06:00:00Z',
      createdAt: '2026-11-20T10:00:00Z',
      visitStatus: 'UPCOMING',
      job: { id: 'job-1', jobNumber: 21127 },
      client: { id: 'client-1' },
      property: null,
    });
    expect(summary).toMatchObject({ number: '21127', jobJobberId: 'job-1', jobberUpdatedAt: null, address: null, fileCount: 0 });
  });

  it('names a client by name and its billing address, archived or not', () => {
    const summary = summarize(JobberRecordKind.CLIENT, {
      id: 'client-1',
      name: 'Jane Tenant',
      isArchived: true,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-02-01T00:00:00Z',
      billingAddress: { street1: '1 Example Way', city: 'Katy', province: 'TX', postalCode: '77494' },
    });
    expect(summary).toMatchObject({ title: 'Jane Tenant', status: 'archived', address: '1 Example Way, Katy, TX 77494' });
  });

  it('refuses a shape it cannot read rather than guessing', () => {
    expect(() => summarize(JobberRecordKind.JOB, { id: 'job-1', createdAt: 'not a date' })).toThrow(TypeError);
    expect(() => summarize(JobberRecordKind.JOB, { id: 'job-1', title: { not: 'text' } })).toThrow(TypeError);
  });
});

describe('isCutShort', () => {
  it('is true when a nested list holds fewer than Jobber says there are', () => {
    expect(isCutShort({ notes: { totalCount: 6, nodes: [1, 2, 3, 4, 5] } })).toBe(true);
    expect(isCutShort({ notes: { totalCount: 5, nodes: [1, 2, 3, 4, 5] } })).toBe(false);
    // A count asked for on its own is not a list.
    expect(isCutShort({ noteAttachments: { totalCount: 9 } })).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx jest test/jobber-mirror-kinds.spec.ts`
Expected: FAIL — cannot find module `jobber-mirror.kinds`.

- [ ] **Step 3: Write the kinds**

`backend/src/integrations/jobber/jobber-mirror.kinds.ts` (field names as corrected by Task 1's probe result):

```ts
import { JobberRecordKind } from '@prisma/client';

import { VISIT_DETAILS_FIELD } from './jobber.queries';

/**
 * Every kind of Jobber record the mirror copies, and what it asks for
 * (2026-11-24).
 *
 * Each selection is wider than the sync's: the point is to keep what the office
 * would otherwise lose when Jobber goes, not only what a screen shows today.
 * Jobber prices a page as `first` times the fields asked, nested lists
 * included, so nested lists are kept short on a page and a record that has
 * more is read again by itself (`isCutShort`) -- the way the invoice read
 * handles long invoices.
 */

export interface NestedLimits {
  notes: number;
  lines: number;
}

export const PAGE_LIMITS: NestedLimits = { notes: 5, lines: 20 };
export const ALONE_LIMITS: NestedLimits = { notes: 50, lines: 100 };

export interface MirrorKind {
  kind: JobberRecordKind;
  /** Root list, e.g. `jobs`. */
  connection: string;
  /** Root single-record field, for a record read by itself; null when Jobber has none worth using. */
  single: string | null;
  pageSize: number;
  /** How "what changed" is read: by update time, by a window of start dates, or not at all (walked daily). */
  changes: 'updatedAt' | 'startAtWindow' | null;
  /** Has `noteAttachments`. */
  hasFiles: boolean;
  select(limits: NestedLimits): string;
}

const ADDRESS = 'address { street1 street2 city province postalCode }';
const notes = (noteType: string, first: number) =>
  `notes(first: ${first}) { totalCount nodes { __typename ... on ${noteType} { id message createdAt } } }`;
const FILE_COUNT = 'noteAttachments(first: 1) { totalCount }';

export const MIRROR_KINDS: readonly MirrorKind[] = [
  {
    kind: JobberRecordKind.CLIENT,
    connection: 'clients',
    single: 'client',
    pageSize: 25,
    changes: 'updatedAt',
    hasFiles: true,
    select: (l) => `
      id name firstName lastName companyName isCompany isArchived createdAt updatedAt
      emails { address description primary }
      phones { number description primary }
      billingAddress { street1 street2 city province postalCode }
      ${notes('ClientNote', l.notes)} ${FILE_COUNT}`,
  },
  {
    kind: JobberRecordKind.PROPERTY,
    connection: 'properties',
    single: null,
    pageSize: 50,
    changes: null,
    hasFiles: false,
    select: () => `id ${ADDRESS} client { id name }`,
  },
  {
    kind: JobberRecordKind.JOB,
    connection: 'jobs',
    single: 'job',
    pageSize: 25,
    changes: 'updatedAt',
    hasFiles: true,
    select: (l) => `
      id jobNumber title instructions jobStatus jobType startAt endAt completedAt createdAt updatedAt total
      client { id name } property { id ${ADDRESS} }
      ${notes('JobNote', l.notes)} ${FILE_COUNT}`,
  },
  {
    kind: JobberRecordKind.VISIT,
    connection: 'visits',
    single: null,
    pageSize: 25,
    changes: 'startAtWindow',
    hasFiles: false,
    select: () => `
      id title ${VISIT_DETAILS_FIELD} startAt endAt completedAt createdAt visitStatus allDay
      job { id jobNumber } client { id name } property { id ${ADDRESS} }
      assignedUsers(first: 5) { nodes { id name { full } } }`,
  },
  {
    kind: JobberRecordKind.QUOTE,
    connection: 'quotes',
    single: 'quote',
    pageSize: 10,
    changes: 'updatedAt',
    hasFiles: true,
    select: (l) => `
      id quoteNumber title quoteStatus createdAt updatedAt
      amounts { subtotal total }
      client { id name } property { id ${ADDRESS} }
      lineItems(first: ${l.lines}) { totalCount nodes { name description quantity unitPrice totalPrice } }
      ${notes('QuoteNote', l.notes)} ${FILE_COUNT}`,
  },
  {
    kind: JobberRecordKind.REQUEST,
    connection: 'requests',
    single: 'request',
    pageSize: 25,
    changes: 'updatedAt',
    hasFiles: true,
    select: (l) => `
      id title requestStatus createdAt updatedAt
      client { id name } property { id ${ADDRESS} }
      ${notes('RequestNote', l.notes)} ${FILE_COUNT}`,
  },
];

export function mirrorKind(kind: JobberRecordKind): MirrorKind {
  const spec = MIRROR_KINDS.find((k) => k.kind === kind);
  if (!spec) throw new Error(`No mirror kind ${kind}.`);
  return spec;
}

const pascal = (value: string) => value[0]!.toUpperCase() + value.slice(1);

export function mirrorPageQuery(spec: MirrorKind, mode: 'walk' | 'changes'): string {
  const variables = ['$first: Int!', '$after: String'];
  let filter = '';
  if (mode === 'changes' && spec.changes === 'updatedAt') {
    variables.push('$since: ISO8601DateTime');
    filter = 'filter: { updatedAt: { after: $since } }';
  } else if (mode === 'changes' && spec.changes === 'startAtWindow') {
    variables.push('$from: ISO8601DateTime', '$to: ISO8601DateTime');
    filter = 'filter: { startAt: { after: $from, before: $to } }';
  }
  return `
  query Mirror${pascal(spec.connection)}(${variables.join(', ')}) {
    ${spec.connection}(first: $first, after: $after ${filter}) {
      nodes { ${spec.select(PAGE_LIMITS)} }
      pageInfo { hasNextPage endCursor }
    }
  }`;
}

export function mirrorOneQuery(spec: MirrorKind): string {
  if (!spec.single) throw new Error(`${spec.kind} is not read by itself.`);
  return `
  query MirrorOne${pascal(spec.single)}($id: EncodedId!) {
    ${spec.single}(id: $id) { ${spec.select(ALONE_LIMITS)} }
  }`;
}

/** The same attachment fields the invoice file copy reads, plus the name. */
export function mirrorFilesQuery(spec: MirrorKind): string {
  if (!spec.single || !spec.hasFiles) throw new Error(`${spec.kind} has no attachments to list.`);
  return `
  query MirrorFiles${pascal(spec.single)}($id: EncodedId!) {
    ${spec.single}(id: $id) {
      id
      noteAttachments(first: 100) {
        nodes { id fileName contentType fileSize url downloadUrl downloadContentType }
      }
    }
  }`;
}

export interface RecordSummary {
  number: string | null;
  title: string | null;
  clientJobberId: string | null;
  propertyJobberId: string | null;
  jobJobberId: string | null;
  address: string | null;
  occursAt: Date | null;
  status: string | null;
  jobberCreatedAt: Date | null;
  jobberUpdatedAt: Date | null;
  fileCount: number;
}

type Node = Record<string, unknown>;

const text = (value: unknown): string | null => {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  throw new TypeError('Expected text.');
};

const date = (value: unknown): Date | null => {
  const raw = text(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`Not a date: ${raw}`);
  return parsed;
};

const child = (node: Node, key: string): Node | null => {
  const value = node[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`Expected ${key} to be an object.`);
  return value as Node;
};

const idOf = (node: Node | null) => (node ? text(node.id) : null);

const oneLine = (address: Node | null): string | null => {
  if (!address) return null;
  const street = [text(address.street1), text(address.street2)].filter(Boolean).join(' ');
  const region = [text(address.province), text(address.postalCode)].filter(Boolean).join(' ');
  return [street, text(address.city), region].filter(Boolean).join(', ') || null;
};

/** The columns a mirrored record is found by. Throws on a shape it cannot read; the caller keeps the payload anyway. */
export function summarize(kind: JobberRecordKind, node: Node): RecordSummary {
  const client = child(node, 'client');
  const property = child(node, 'property');
  const job = child(node, 'job');
  const createdAt = date(node.createdAt);
  const startAt = date(node.startAt);
  const files = child(node, 'noteAttachments');

  const byKind: Record<JobberRecordKind, () => Pick<RecordSummary, 'number' | 'title' | 'address' | 'status' | 'occursAt'>> = {
    CLIENT: () => ({
      number: null,
      title: text(node.name),
      address: oneLine(child(node, 'billingAddress')),
      status: node.isArchived === true ? 'archived' : 'active',
      occursAt: createdAt,
    }),
    PROPERTY: () => {
      const line = oneLine(child(node, 'address'));
      return { number: null, title: line, address: line, status: null, occursAt: null };
    },
    JOB: () => ({
      number: text(node.jobNumber),
      title: text(node.title),
      address: oneLine(property ? child(property, 'address') : null),
      status: text(node.jobStatus),
      occursAt: startAt ?? createdAt,
    }),
    VISIT: () => ({
      number: job ? text(job.jobNumber) : null,
      title: text(node.title),
      address: oneLine(property ? child(property, 'address') : null),
      status: text(node.visitStatus),
      occursAt: startAt ?? createdAt,
    }),
    QUOTE: () => ({
      number: text(node.quoteNumber),
      title: text(node.title),
      address: oneLine(property ? child(property, 'address') : null),
      status: text(node.quoteStatus),
      occursAt: createdAt,
    }),
    REQUEST: () => ({
      number: null,
      title: text(node.title),
      address: oneLine(property ? child(property, 'address') : null),
      status: text(node.requestStatus),
      occursAt: createdAt,
    }),
  };

  return {
    ...byKind[kind](),
    clientJobberId: idOf(client),
    propertyJobberId: kind === JobberRecordKind.PROPERTY ? null : idOf(property),
    jobJobberId: kind === JobberRecordKind.VISIT ? idOf(job) : null,
    jobberCreatedAt: createdAt,
    jobberUpdatedAt: date(node.updatedAt),
    fileCount: typeof files?.totalCount === 'number' ? files.totalCount : 0,
  };
}

/** A nested list on the record holds fewer items than Jobber says it has. */
export function isCutShort(node: Node): boolean {
  return Object.values(node).some((value) => {
    if (!value || typeof value !== 'object') return false;
    const list = value as { totalCount?: unknown; nodes?: unknown };
    return typeof list.totalCount === 'number' && Array.isArray(list.nodes) && list.totalCount > list.nodes.length;
  });
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `npx jest test/jobber-mirror-kinds.spec.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/integrations/jobber/jobber-mirror.kinds.ts test/jobber-mirror-kinds.spec.ts
git commit -m "feat(jobber): what the mirror reads for each kind of Jobber record, and how a record is found again"
```

---

### Task 4: The store and the record worker

**Files:**
- Create: `backend/src/integrations/jobber/jobber-mirror.store.ts`
- Create: `backend/src/workers/jobber-sync/jobber-mirror.worker.ts`
- Test: `backend/test/jobber-mirror-store.spec.ts`, `backend/test/jobber-mirror-worker.spec.ts`

**Interfaces:**
- Consumes: Task 3's `MIRROR_KINDS`, `mirrorPageQuery`, `mirrorOneQuery`, `summarize`, `isCutShort`; `JobberClient.requestDetailed(org, query, vars): Promise<{ data: unknown; cost?: JobberCost }>`, `JobberClient.request(org, query, vars)`; `JobberError` (`code`, `retryable`).
- Produces:
  - `saveMirrorPage(prisma, organizationId, kind, nodes: MirrorNode[], seenAt: Date, cursor: Prisma.JobberMirrorCursorUncheckedUpdateInput): Promise<{ saved: number; extractFailed: number }>`
  - `markUnseenDeleted(prisma, organizationId, kind, walkStartedAt: Date, walkSeen: number): Promise<{ deleted: number; short: boolean }>`
  - `type MirrorNode = Record<string, unknown> & { id: string }`
  - `class JobberMirrorWorker { run(organizationId: string, now?: Date): Promise<MirrorRunResult> }`
  - `interface MirrorRunResult { skipped: 'NOT_CONNECTED' | null; pages: number; kinds: MirrorKindResult[] }`
  - `interface MirrorKindResult { kind: JobberRecordKind; mode: 'walk' | 'changes'; pages: number; saved: number; readAlone: number; caughtUp: boolean; deleted: number; problem: string | null }`

- [ ] **Step 1: Write the failing store tests**

`backend/test/jobber-mirror-store.spec.ts`:

```ts
import { JobberRecordKind } from '@prisma/client';

import { markUnseenDeleted, saveMirrorPage } from '../src/integrations/jobber/jobber-mirror.store';

/** Writing mirrored records (2026-11-24): one row per record, however often it is read. Ids invented. */

const ORG = '30000000-0000-4000-8000-000000000001';
const SEEN = new Date('2026-11-24T12:00:00Z');

function setup() {
  const tx = {
    jobberRecord: {
      upsert: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    jobberMirrorCursor: { upsert: jest.fn().mockResolvedValue({}) },
  };
  const prisma = { ...tx, $transaction: jest.fn((work: (t: typeof tx) => unknown) => work(tx)) };
  return { prisma, tx };
}

describe('saveMirrorPage', () => {
  it('upserts each record by organization, kind and Jobber id, and moves the cursor in the same transaction', async () => {
    const { prisma, tx } = setup();
    const node = { id: 'job-1', jobNumber: 7, title: 'Fix sink', createdAt: '2026-11-01T00:00:00Z' };

    const result = await saveMirrorPage(prisma as never, ORG, JobberRecordKind.JOB, [node], SEEN, { walkCursor: 'c-1' });

    expect(result).toEqual({ saved: 1, extractFailed: 0 });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const call = tx.jobberRecord.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ organizationId_kind_jobberId: { organizationId: ORG, kind: 'JOB', jobberId: 'job-1' } });
    expect(call.update).toMatchObject({ payload: node, number: '7', lastSeenAt: SEEN, deletedInJobberAt: null, extractFailed: false });
    expect(call.create).toMatchObject({ organizationId: ORG, kind: 'JOB', jobberId: 'job-1' });
    expect(tx.jobberMirrorCursor.upsert).toHaveBeenCalledWith({
      where: { organizationId_kind: { organizationId: ORG, kind: 'JOB' } },
      create: { organizationId: ORG, kind: 'JOB', walkCursor: 'c-1' },
      update: { walkCursor: 'c-1' },
    });
  });

  it('brings a record back that Jobber had deleted and restored', async () => {
    const { prisma, tx } = setup();
    await saveMirrorPage(prisma as never, ORG, JobberRecordKind.CLIENT, [{ id: 'client-1', name: 'Back again' }], SEEN, {});
    expect(tx.jobberRecord.upsert.mock.calls[0][0].update.deletedInJobberAt).toBeNull();
  });

  it('keeps the payload of a record it cannot summarize, flagged', async () => {
    const { prisma, tx } = setup();
    const odd = { id: 'job-2', createdAt: 'yesterday-ish' };
    const result = await saveMirrorPage(prisma as never, ORG, JobberRecordKind.JOB, [odd], SEEN, {});
    expect(result).toEqual({ saved: 1, extractFailed: 1 });
    expect(tx.jobberRecord.upsert.mock.calls[0][0].update).toMatchObject({ payload: odd, extractFailed: true, number: null });
  });
});

describe('markUnseenDeleted', () => {
  it('marks rows the finished walk did not see', async () => {
    const { prisma, tx } = setup();
    tx.jobberRecord.count.mockResolvedValue(100);
    tx.jobberRecord.updateMany.mockResolvedValue({ count: 3 });
    const started = new Date('2026-11-24T00:00:00Z');

    const result = await markUnseenDeleted(prisma as never, ORG, JobberRecordKind.JOB, started, 97);

    expect(result).toEqual({ deleted: 3, short: false });
    expect(tx.jobberRecord.updateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, kind: 'JOB', deletedInJobberAt: null, lastSeenAt: { lt: started } },
      data: { deletedInJobberAt: expect.any(Date) },
    });
  });

  it('marks nothing when the walk saw under half of what is live -- Jobber hid records, they were not deleted', async () => {
    const { prisma, tx } = setup();
    tx.jobberRecord.count.mockResolvedValue(1_000);

    const result = await markUnseenDeleted(prisma as never, ORG, JobberRecordKind.JOB, new Date(), 400);

    expect(result).toEqual({ deleted: 0, short: true });
    expect(tx.jobberRecord.updateMany).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx jest test/jobber-mirror-store.spec.ts`
Expected: FAIL — cannot find module `jobber-mirror.store`.

- [ ] **Step 3: Write the store**

`backend/src/integrations/jobber/jobber-mirror.store.ts`:

```ts
import type { JobberRecordKind, Prisma, PrismaClient } from '@prisma/client';

import { summarize, type RecordSummary } from './jobber-mirror.kinds';

export type MirrorNode = Record<string, unknown> & { id: string };

type Db = Pick<PrismaClient, '$transaction' | 'jobberRecord' | 'jobberMirrorCursor'>;

const EMPTY: RecordSummary = {
  number: null,
  title: null,
  clientJobberId: null,
  propertyJobberId: null,
  jobJobberId: null,
  address: null,
  occursAt: null,
  status: null,
  jobberCreatedAt: null,
  jobberUpdatedAt: null,
  fileCount: 0,
};

/** A walk that saw fewer than this share of the live rows marks nothing deleted. */
const SHORT_WALK_RATIO = 0.5;

/**
 * One page of mirrored records and the cursor that follows it, in one
 * transaction (2026-11-24): a run cut off after this returns resumes after
 * this page, never before or past it.
 *
 * Upserted on organization, kind and Jobber id, so a page read twice -- a
 * resumed walk, a "what changed" overlapping the walk -- leaves one row. A
 * record seen again is no longer deleted: Jobber restored it.
 */
export async function saveMirrorPage(
  prisma: Db,
  organizationId: string,
  kind: JobberRecordKind,
  nodes: MirrorNode[],
  seenAt: Date,
  cursor: Omit<Prisma.JobberMirrorCursorUncheckedCreateInput, 'organizationId' | 'kind'>,
) {
  let extractFailed = 0;
  await prisma.$transaction(async (tx) => {
    for (const node of nodes) {
      let summary = EMPTY;
      let failed = false;
      try {
        summary = summarize(kind, node);
      } catch {
        failed = true;
        extractFailed += 1;
      }
      const data = {
        ...summary,
        payload: node as Prisma.InputJsonValue,
        extractFailed: failed,
        lastSeenAt: seenAt,
        deletedInJobberAt: null,
      };
      await tx.jobberRecord.upsert({
        where: { organizationId_kind_jobberId: { organizationId, kind, jobberId: node.id } },
        create: { organizationId, kind, jobberId: node.id, ...data },
        update: data,
      });
    }
    await tx.jobberMirrorCursor.upsert({
      where: { organizationId_kind: { organizationId, kind } },
      create: { organizationId, kind, ...cursor },
      update: cursor,
    });
  });
  return { saved: nodes.length, extractFailed };
}

/**
 * After a full walk: what it did not see is gone from Jobber (2026-11-24).
 * Marked, never erased.
 *
 * Unless the walk saw under half of what is live. Records do not vanish by the
 * hundred; a permission change in Jobber hiding them does, and marking them
 * would empty the copy the day it is needed.
 */
export async function markUnseenDeleted(
  prisma: Db,
  organizationId: string,
  kind: JobberRecordKind,
  walkStartedAt: Date,
  walkSeen: number,
) {
  return prisma.$transaction(async (tx) => {
    const live = await tx.jobberRecord.count({ where: { organizationId, kind, deletedInJobberAt: null } });
    if (live > 0 && walkSeen < live * SHORT_WALK_RATIO) return { deleted: 0, short: true };
    const marked = await tx.jobberRecord.updateMany({
      where: { organizationId, kind, deletedInJobberAt: null, lastSeenAt: { lt: walkStartedAt } },
      data: { deletedInJobberAt: new Date() },
    });
    return { deleted: marked.count, short: false };
  });
}
```

- [ ] **Step 4: Run the store tests to see them pass**

Run: `npx jest test/jobber-mirror-store.spec.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing worker tests**

`backend/test/jobber-mirror-worker.spec.ts`:

```ts
import { JobberConnectionStatus, JobberRecordKind } from '@prisma/client';

import { MIRROR_KINDS } from '../src/integrations/jobber/jobber-mirror.kinds';
import { markUnseenDeleted, saveMirrorPage } from '../src/integrations/jobber/jobber-mirror.store';
import { JobberError } from '../src/integrations/jobber/jobber.errors';
import { JobberMirrorWorker } from '../src/workers/jobber-sync/jobber-mirror.worker';

jest.mock('../src/integrations/jobber/jobber-mirror.store', () => ({
  saveMirrorPage: jest.fn().mockResolvedValue({ saved: 0, extractFailed: 0 }),
  markUnseenDeleted: jest.fn().mockResolvedValue({ deleted: 0, short: false }),
}));

/**
 * The mirror's bounded run (2026-11-24): walk every record once, keep its
 * place, then read only what changed; one kind failing never stops the next.
 * Ids invented.
 */

const ORG = '30000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-11-24T12:00:00Z');
const HOUR = 3_600_000;

const page = (connection: string, nodes: object[], hasNextPage: boolean, endCursor: string | null, available = 9_000) => ({
  data: { [connection]: { nodes, pageInfo: { hasNextPage, endCursor } } },
  cost: { requestedQueryCost: 1_000, actualQueryCost: 300, throttleStatus: { maximumAvailable: 10_000, currentlyAvailable: available, restoreRate: 500 } },
});

type Cursor = Partial<{
  walkCursor: string | null;
  walkStartedAt: Date | null;
  walkCompletedAt: Date | null;
  walkSeen: number;
  changesCursor: string | null;
  changesStartedAt: Date | null;
  changesCompletedAt: Date | null;
  changesSince: Date | null;
}>;

/** Every kind caught up an hour ago unless a test says otherwise, so only the kind under test reads. */
const caughtUp: Cursor = {
  walkCompletedAt: new Date(NOW.getTime() - HOUR),
  walkStartedAt: new Date(NOW.getTime() - 2 * HOUR),
  changesCompletedAt: new Date(NOW.getTime() - 10 * 60_000),
  changesSince: new Date(NOW.getTime() - HOUR),
};

function setup(cursors: Partial<Record<JobberRecordKind, Cursor>> = {}, connected = true) {
  const prisma = {
    jobberConnection: {
      findUnique: jest.fn().mockResolvedValue(connected ? { status: JobberConnectionStatus.CONNECTED } : null),
    },
    jobberMirrorCursor: {
      findUnique: jest.fn(async ({ where }: { where: { organizationId_kind: { kind: JobberRecordKind } } }) => {
        const kind = where.organizationId_kind.kind;
        return { walkSeen: 0, ...(cursors[kind] ?? caughtUp) };
      }),
      upsert: jest.fn().mockResolvedValue({}),
    },
  };
  const client = { requestDetailed: jest.fn(), request: jest.fn() };
  const worker = new JobberMirrorWorker(prisma as never, client as never);
  const sleep = jest.spyOn(worker as unknown as { sleep: (ms: number) => Promise<void> }, 'sleep').mockResolvedValue();
  const savedCursors = () => jest.mocked(saveMirrorPage).mock.calls.map((call) => call[5]);
  return { prisma, client, worker, sleep, savedCursors };
}

beforeEach(() => {
  jest.mocked(saveMirrorPage).mockClear();
  jest.mocked(markUnseenDeleted).mockClear().mockResolvedValue({ deleted: 0, short: false });
});

describe('the first walk', () => {
  it('pages through every job, keeps its place each page, and hands over to "what changed"', async () => {
    const { client, worker, savedCursors } = setup({ JOB: {} });
    client.requestDetailed
      .mockResolvedValueOnce(page('jobs', [{ id: 'job-1' }, { id: 'job-2' }], true, 'c-1'))
      .mockResolvedValueOnce(page('jobs', [{ id: 'job-3' }], false, 'c-2'));

    const result = await worker.run(ORG, NOW);

    expect(result.kinds).toEqual([
      expect.objectContaining({ kind: 'JOB', mode: 'walk', pages: 2, saved: 3, caughtUp: true, problem: null }),
    ]);
    expect(client.requestDetailed.mock.calls[0][2]).toEqual({ first: 25, after: null });
    expect(client.requestDetailed.mock.calls[1][2]).toEqual({ first: 25, after: 'c-1' });
    const [first, last] = savedCursors();
    expect(first).toMatchObject({ walkCursor: 'c-1', walkStartedAt: NOW, walkSeen: 2, lastError: null });
    expect(last).toMatchObject({ walkCursor: null, walkCompletedAt: NOW, walkSeen: 3, changesCursor: null });
    // Five minutes before the walk began, so what changed during it is read again.
    expect(last.changesSince).toEqual(new Date(NOW.getTime() - 5 * 60_000));
    expect(markUnseenDeleted).toHaveBeenCalledWith(expect.anything(), ORG, 'JOB', NOW, 3);
  });

  it('resumes a walk from the cursor it saved, counting what it already saw', async () => {
    const started = new Date(NOW.getTime() - 3 * HOUR);
    const { client, worker, savedCursors } = setup({ JOB: { walkCursor: 'c-9', walkStartedAt: started, walkSeen: 500 } });
    client.requestDetailed.mockResolvedValueOnce(page('jobs', [{ id: 'job-501' }], false, null));

    await worker.run(ORG, NOW);

    expect(client.requestDetailed.mock.calls[0][2]).toEqual({ first: 25, after: 'c-9' });
    expect(savedCursors()[0]).toMatchObject({ walkSeen: 501 });
    expect(markUnseenDeleted).toHaveBeenCalledWith(expect.anything(), ORG, 'JOB', started, 501);
  });

  it('records WALK_SHORT and keeps every row when the walk saw too few', async () => {
    const { client, worker, prisma } = setup({ JOB: {} });
    client.requestDetailed.mockResolvedValueOnce(page('jobs', [{ id: 'job-1' }], false, null));
    jest.mocked(markUnseenDeleted).mockResolvedValueOnce({ deleted: 0, short: true });

    const result = await worker.run(ORG, NOW);

    expect(result.kinds[0]).toMatchObject({ problem: 'WALK_SHORT', deleted: 0 });
    expect(prisma.jobberMirrorCursor.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ lastError: 'WALK_SHORT' }) }),
    );
  });

  it('reads a job with more notes than a page carries again by itself', async () => {
    const { client, worker } = setup({ JOB: {} });
    const long = { id: 'job-1', notes: { totalCount: 7, nodes: [1, 2, 3, 4, 5] } };
    const whole = { id: 'job-1', notes: { totalCount: 7, nodes: [1, 2, 3, 4, 5, 6, 7] } };
    client.requestDetailed.mockResolvedValueOnce(page('jobs', [long], false, null));
    client.request.mockResolvedValueOnce({ job: whole });

    const result = await worker.run(ORG, NOW);

    expect(client.request.mock.calls[0][2]).toEqual({ id: 'job-1' });
    expect(jest.mocked(saveMirrorPage).mock.calls[0][3]).toEqual([whole]);
    expect(result.kinds[0]).toMatchObject({ readAlone: 1 });
  });
});

describe('what changed', () => {
  it('asks for jobs changed since the last pass, a second early', async () => {
    const since = new Date(NOW.getTime() - 2 * HOUR);
    const { client, worker, savedCursors } = setup({
      JOB: { ...caughtUp, changesCompletedAt: new Date(NOW.getTime() - 2 * HOUR), changesSince: since },
    });
    client.requestDetailed.mockResolvedValueOnce(page('jobs', [{ id: 'job-1' }], false, null));

    await worker.run(ORG, NOW);

    expect(client.requestDetailed.mock.calls[0][1]).toContain('updatedAt: { after: $since }');
    expect(client.requestDetailed.mock.calls[0][2]).toEqual({ first: 25, after: null, since: new Date(since.getTime() - 1_000).toISOString() });
    expect(savedCursors()[0]).toMatchObject({ changesCursor: null, changesCompletedAt: NOW, changesSince: new Date(NOW.getTime() - 5 * 60_000) });
  });

  it('re-reads visits in a window of start dates, since visits have no update time', async () => {
    const { client, worker } = setup({ VISIT: { ...caughtUp, changesCompletedAt: new Date(NOW.getTime() - 2 * HOUR) } });
    client.requestDetailed.mockResolvedValueOnce(page('visits', [], false, null));

    await worker.run(ORG, NOW);

    expect(client.requestDetailed.mock.calls[0][2]).toEqual({
      first: 25,
      after: null,
      from: new Date(NOW.getTime() - 30 * 24 * HOUR).toISOString(),
      to: new Date(NOW.getTime() + 120 * 24 * HOUR).toISOString(),
    });
  });

  it('reads nothing for a kind that caught up within the hour', async () => {
    const { client, worker } = setup();
    const result = await worker.run(ORG, NOW);
    expect(client.requestDetailed).not.toHaveBeenCalled();
    expect(result.kinds).toEqual([]);
  });

  it('walks properties again daily, since Jobber gives them no update time', async () => {
    const { client, worker } = setup({ PROPERTY: { ...caughtUp, walkCompletedAt: new Date(NOW.getTime() - 25 * HOUR) } });
    client.requestDetailed.mockResolvedValueOnce(page('properties', [], false, null));
    const result = await worker.run(ORG, NOW);
    expect(result.kinds[0]).toMatchObject({ kind: 'PROPERTY', mode: 'walk' });
  });
});

describe('when something goes wrong', () => {
  it('records a failing kind and carries on with the next', async () => {
    const { client, worker, prisma } = setup({ CLIENT: {}, JOB: {} });
    client.requestDetailed
      .mockRejectedValueOnce(new JobberError("Field 'isCompany' doesn't exist", 'JOBBER_GRAPHQL_ERROR'))
      .mockResolvedValueOnce(page('jobs', [{ id: 'job-1' }], false, null));

    const result = await worker.run(ORG, NOW);

    expect(result.kinds.map((k) => [k.kind, k.problem])).toEqual([
      ['CLIENT', 'JOBBER_GRAPHQL_ERROR'],
      ['JOB', null],
    ]);
    expect(prisma.jobberMirrorCursor.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId_kind: { organizationId: ORG, kind: 'CLIENT' } },
        update: expect.objectContaining({ lastError: 'JOBBER_GRAPHQL_ERROR', lastErrorAt: NOW }),
      }),
    );
  });

  it('stops the whole run on THROTTLED, keeping every cursor, so the next tick resumes the same kind', async () => {
    const { client, worker, sleep } = setup({ CLIENT: {}, JOB: {} });
    const throttled = new JobberError('Throttled', 'JOBBER_THROTTLED', 429, true);
    client.requestDetailed.mockRejectedValue(throttled);

    const result = await worker.run(ORG, NOW);

    expect(result.kinds).toEqual([expect.objectContaining({ kind: 'CLIENT', problem: 'THROTTLED' })]);
    expect(saveMirrorPage).not.toHaveBeenCalled();
    // Two short waits, then it gives the tick back.
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('waits for the bucket to refill before the next page', async () => {
    const { client, worker, sleep } = setup({ JOB: {} });
    client.requestDetailed
      .mockResolvedValueOnce(page('jobs', [{ id: 'job-1' }], true, 'c-1', 500))
      .mockResolvedValueOnce(page('jobs', [], false, null));

    await worker.run(ORG, NOW);

    // (1,000 requested + 1,000 reserve - 500 available) / 500 a second = 3 seconds.
    expect(sleep).toHaveBeenCalledWith(3_000);
  });

  it('reads nothing when Jobber is not connected', async () => {
    const { client, worker } = setup({ JOB: {} }, false);
    expect(await worker.run(ORG, NOW)).toEqual({ skipped: 'NOT_CONNECTED', pages: 0, kinds: [] });
    expect(client.requestDetailed).not.toHaveBeenCalled();
  });

  it('never reads more than forty pages in a run', async () => {
    const { client, worker } = setup(Object.fromEntries(MIRROR_KINDS.map((k) => [k.kind, {}])));
    let n = 0;
    client.requestDetailed.mockImplementation(async (_org: string, query: string) => {
      const connection = MIRROR_KINDS.find((k) => query.includes(`${k.connection}(first:`))!.connection;
      n += 1;
      return page(connection, [{ id: `r-${n}` }], true, `c-${n}`);
    });

    const result = await worker.run(ORG, NOW);

    expect(result.pages).toBe(40);
    expect(client.requestDetailed).toHaveBeenCalledTimes(40);
  });
});
```

- [ ] **Step 6: Run them to see them fail**

Run: `npx jest test/jobber-mirror-worker.spec.ts`
Expected: FAIL — cannot find module `jobber-mirror.worker`.

- [ ] **Step 7: Write the worker**

`backend/src/workers/jobber-sync/jobber-mirror.worker.ts`:

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { JobberConnectionStatus, type JobberMirrorCursor, type JobberRecordKind } from '@prisma/client';
import { z } from 'zod';

import { PrismaService } from '../../common/prisma.service';
import {
  isCutShort,
  MIRROR_KINDS,
  mirrorOneQuery,
  mirrorPageQuery,
  type MirrorKind,
} from '../../integrations/jobber/jobber-mirror.kinds';
import { markUnseenDeleted, saveMirrorPage, type MirrorNode } from '../../integrations/jobber/jobber-mirror.store';
import { JobberClient, type JobberCost } from '../../integrations/jobber/jobber.client';
import { JobberError } from '../../integrations/jobber/jobber.errors';

/**
 * Pages one run reads across every kind, and how long it may take. The first
 * walk of every visit and job is thousands of pages; read at once it would
 * hold the scheduler's tick for hours. So a run stops here, every kind keeps
 * its place, and the next tick carries on.
 */
const MAX_PAGES_PER_RUN = 40;
const RUN_BUDGET_MS = 90_000;

/** A full walk again weekly, so deletions are noticed; daily for a kind Jobber gives no "what changed". */
const WALK_AGAIN_MS = 7 * 24 * 3_600_000;
const WALK_AGAIN_UNFILTERED_MS = 24 * 3_600_000;
/** How often "what changed" is read for a kind that has caught up. */
const CHANGES_EVERY_MS = 60 * 60_000;
/** A pass's next "since" is this long before it began, so an edit during it is read again. */
const PASS_MARGIN_MS = 5 * 60_000;
/** Jobber's `after` is strict: one second of overlap costs a re-save that changes nothing. */
const OVERLAP_MS = 1_000;
/** Visits have no update time, so the ones that still move are re-read by date. */
const VISIT_BACK_DAYS = 30;
const VISIT_AHEAD_DAYS = 120;
const DAY_MS = 24 * 3_600_000;

const THROTTLE_WAIT_MS = 15_000;
const THROTTLE_RETRIES = 2;
const BUCKET_RESERVE = 1_000;
const MAX_PACE_WAIT_SECONDS = 30;

const pageSchema = z.object({
  nodes: z.array(z.object({ id: z.string() }).passthrough()),
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
});

export interface MirrorKindResult {
  kind: JobberRecordKind;
  mode: 'walk' | 'changes';
  pages: number;
  saved: number;
  readAlone: number;
  caughtUp: boolean;
  deleted: number;
  problem: string | null;
}

export interface MirrorRunResult {
  skipped: 'NOT_CONNECTED' | null;
  pages: number;
  kinds: MirrorKindResult[];
}

type CursorState = Partial<Pick<
  JobberMirrorCursor,
  | 'walkCursor'
  | 'walkStartedAt'
  | 'walkCompletedAt'
  | 'walkSeen'
  | 'changesCursor'
  | 'changesStartedAt'
  | 'changesCompletedAt'
  | 'changesSince'
>>;

class Throttled extends Error {}

/**
 * Copies every Jobber record into `JobberRecord` (2026-11-24), read-only.
 *
 * Each kind is walked once from the start, then read for "what changed" --
 * by update time, or for visits by a window of dates -- and walked again
 * weekly (daily for properties) so a record deleted in Jobber is noticed. A run
 * is bounded and paces itself on the bucket Jobber reports, after the visit
 * sync and the invoice read have had the tick.
 */
@Injectable()
export class JobberMirrorWorker {
  private readonly logger = new Logger(JobberMirrorWorker.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(JobberClient) private readonly client: JobberClient,
  ) {}

  async run(organizationId: string, now: Date = new Date()): Promise<MirrorRunResult> {
    const result: MirrorRunResult = { skipped: null, pages: 0, kinds: [] };
    const connection = await this.prisma.jobberConnection.findUnique({
      where: { organizationId },
      select: { status: true },
    });
    if (connection?.status !== JobberConnectionStatus.CONNECTED) return { ...result, skipped: 'NOT_CONNECTED' };

    const started = Date.now();
    for (const spec of MIRROR_KINDS) {
      if (result.pages >= MAX_PAGES_PER_RUN || Date.now() - started >= RUN_BUDGET_MS) break;
      const cursor: CursorState =
        (await this.prisma.jobberMirrorCursor.findUnique({
          where: { organizationId_kind: { organizationId, kind: spec.kind } },
        })) ?? {};
      const mode = this.modeFor(spec, cursor, now);
      if (!mode) continue;
      const kindResult: MirrorKindResult = {
        kind: spec.kind,
        mode,
        pages: 0,
        saved: 0,
        readAlone: 0,
        caughtUp: false,
        deleted: 0,
        problem: null,
      };
      result.kinds.push(kindResult);
      try {
        await this.read(organizationId, spec, mode, cursor, now, started, result, kindResult);
      } catch (error) {
        if (error instanceof Throttled) {
          // The bucket is empty for everyone: give the tick back. Every cursor
          // is where the last saved page left it.
          kindResult.problem = 'THROTTLED';
          break;
        }
        kindResult.problem = error instanceof JobberError ? error.code : 'UNEXPECTED';
        await this.recordError(organizationId, spec.kind, kindResult.problem, now);
        this.logger.error({
          event: 'jobber_mirror_kind_failed',
          organizationId,
          kind: spec.kind,
          code: kindResult.problem,
          message: error instanceof Error ? error.message : 'unexpected',
        });
      }
    }
    return result;
  }

  /** Whether this kind has anything to read this run, and how. */
  private modeFor(spec: MirrorKind, cursor: CursorState, now: Date): 'walk' | 'changes' | null {
    if (cursor.walkCursor || !cursor.walkCompletedAt) return 'walk';
    const walkAgain = spec.changes ? WALK_AGAIN_MS : WALK_AGAIN_UNFILTERED_MS;
    if (now.getTime() - cursor.walkCompletedAt.getTime() >= walkAgain) return 'walk';
    if (!spec.changes) return null;
    if (cursor.changesCursor) return 'changes';
    if (!cursor.changesCompletedAt || now.getTime() - cursor.changesCompletedAt.getTime() >= CHANGES_EVERY_MS)
      return 'changes';
    return null;
  }

  private async read(
    organizationId: string,
    spec: MirrorKind,
    mode: 'walk' | 'changes',
    cursor: CursorState,
    now: Date,
    started: number,
    run: MirrorRunResult,
    result: MirrorKindResult,
  ) {
    // A walk in progress keeps its start; a new one starts now and counts from nothing.
    const continuing = mode === 'walk' ? Boolean(cursor.walkCursor) : Boolean(cursor.changesCursor);
    const passStartedAt = continuing ? ((mode === 'walk' ? cursor.walkStartedAt : cursor.changesStartedAt) ?? now) : now;
    let after = continuing ? ((mode === 'walk' ? cursor.walkCursor : cursor.changesCursor) ?? null) : null;
    let walkSeen = mode === 'walk' && continuing ? (cursor.walkSeen ?? 0) : 0;
    const variables = this.variablesFor(spec, mode, cursor, passStartedAt);
    const query = mirrorPageQuery(spec, mode);

    while (run.pages < MAX_PAGES_PER_RUN && Date.now() - started < RUN_BUDGET_MS) {
      const { data, cost } = await this.readPage(organizationId, query, { first: spec.pageSize, after, ...variables }, started);
      const page = pageSchema.parse((data as Record<string, unknown>)[spec.connection]);
      const nodes = await this.complete(organizationId, spec, page.nodes as MirrorNode[], result);
      run.pages += 1;
      result.pages += 1;
      result.saved += nodes.length;
      after = page.pageInfo.endCursor;
      const caughtUp = !page.pageInfo.hasNextPage;
      const checked = { lastCheckedAt: now, lastError: null, lastErrorAt: null };

      if (mode === 'walk') {
        walkSeen += nodes.length;
        await saveMirrorPage(this.prisma, organizationId, spec.kind, nodes, now, {
          ...checked,
          walkStartedAt: passStartedAt,
          walkSeen,
          ...(caughtUp
            ? {
                walkCursor: null,
                walkCompletedAt: now,
                changesCursor: null,
                changesStartedAt: null,
                changesSince: new Date(passStartedAt.getTime() - PASS_MARGIN_MS),
              }
            : { walkCursor: after }),
        });
        if (caughtUp) {
          const marked = await markUnseenDeleted(this.prisma, organizationId, spec.kind, passStartedAt, walkSeen);
          result.deleted = marked.deleted;
          if (marked.short) {
            result.problem = 'WALK_SHORT';
            await this.recordError(organizationId, spec.kind, 'WALK_SHORT', now);
          }
        }
      } else {
        await saveMirrorPage(this.prisma, organizationId, spec.kind, nodes, now, {
          ...checked,
          changesStartedAt: passStartedAt,
          ...(caughtUp
            ? {
                changesCursor: null,
                changesCompletedAt: now,
                changesSince: new Date(passStartedAt.getTime() - PASS_MARGIN_MS),
              }
            : { changesCursor: after }),
        });
      }
      if (caughtUp) {
        result.caughtUp = true;
        return;
      }
      if (!(await this.pace(cost, started))) return;
    }
  }

  private variablesFor(spec: MirrorKind, mode: 'walk' | 'changes', cursor: CursorState, passStartedAt: Date) {
    if (mode === 'walk') return {};
    if (spec.changes === 'startAtWindow')
      return {
        from: new Date(passStartedAt.getTime() - VISIT_BACK_DAYS * DAY_MS).toISOString(),
        to: new Date(passStartedAt.getTime() + VISIT_AHEAD_DAYS * DAY_MS).toISOString(),
      };
    const since = cursor.changesSince ?? cursor.walkStartedAt ?? passStartedAt;
    return { since: new Date(since.getTime() - OVERLAP_MS).toISOString() };
  }

  /** Records with more notes or lines than a page carries, read again by themselves. */
  private async complete(organizationId: string, spec: MirrorKind, nodes: MirrorNode[], result: MirrorKindResult) {
    if (!spec.single) return nodes;
    const out: MirrorNode[] = [];
    for (const node of nodes) {
      if (!isCutShort(node)) {
        out.push(node);
        continue;
      }
      result.readAlone += 1;
      const data = await this.client.request<Record<string, MirrorNode | null>>(organizationId, mirrorOneQuery(spec), {
        id: node.id,
      });
      out.push(data[spec.single] ?? node);
    }
    return out;
  }

  private async recordError(organizationId: string, kind: JobberRecordKind, code: string, now: Date) {
    const data = { lastError: code, lastErrorAt: now, lastCheckedAt: now };
    await this.prisma.jobberMirrorCursor.upsert({
      where: { organizationId_kind: { organizationId, kind } },
      create: { organizationId, kind, ...data },
      update: data,
    });
  }

  private async readPage(organizationId: string, query: string, variables: Record<string, unknown>, started: number) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.client.requestDetailed(organizationId, query, variables);
      } catch (error) {
        const throttled = error instanceof JobberError && error.retryable;
        if (!throttled) throw error;
        if (attempt >= THROTTLE_RETRIES || Date.now() - started + THROTTLE_WAIT_MS > RUN_BUDGET_MS) throw new Throttled();
        await this.sleep(THROTTLE_WAIT_MS);
      }
    }
  }

  /** Waits for the bucket to hold this page's cost plus a reserve; false when the run has no time left to wait. */
  private async pace(cost: JobberCost | undefined, started: number) {
    const status = cost?.throttleStatus;
    if (!status || status.restoreRate <= 0) return true;
    const needed = (cost.requestedQueryCost ?? 0) + BUCKET_RESERVE;
    if (status.currentlyAvailable >= needed) return true;
    const seconds = Math.min((needed - status.currentlyAvailable) / status.restoreRate, MAX_PACE_WAIT_SECONDS);
    if (Date.now() - started + seconds * 1_000 > RUN_BUDGET_MS) return false;
    await this.sleep(seconds * 1_000);
    return true;
  }

  protected sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
```

- [ ] **Step 8: Run both specs to see them pass**

Run: `npx jest test/jobber-mirror-store.spec.ts test/jobber-mirror-worker.spec.ts`
Expected: PASS. If `JobberClient.request` is not generic (`request<T>`), check its signature at `src/integrations/jobber/jobber.client.ts:42` and cast the result instead.

- [ ] **Step 9: Commit**

```bash
git add src/integrations/jobber/jobber-mirror.store.ts src/workers/jobber-sync/jobber-mirror.worker.ts test/jobber-mirror-store.spec.ts test/jobber-mirror-worker.spec.ts
git commit -m "feat(jobber): the mirror walks every Jobber record once, keeps its place, then reads what changed -- paced on Jobber's bucket"
```

---

### Task 5: Copying note attachments

**Files:**
- Create: `backend/src/workers/jobber-sync/jobber-mirror-files.worker.ts`
- Test: `backend/test/jobber-mirror-files.spec.ts`

**Interfaces:**
- Consumes: `mirrorKind`, `mirrorFilesQuery`, `MIRROR_KINDS` (Task 3); from `jobber-invoice-files.worker.ts`: `downloadFile(address)`, `sourceToCopy(link)`, `dueForCopy(file, now)`, `FileCopyError` (`message`, `final`), `MAX_COPY_ATTEMPTS`; `InvoiceFileStorageService.put(key, bytes, contentType)`; `businessDayBounds(now).start`; `ceilingFrom(name, fallback)`.
- Produces:
  - `class JobberMirrorFileWorker { run(organizationId: string, clock?: () => number): Promise<MirrorFileResult> }`
  - `interface MirrorFileResult { listed: number; copied: number; failed: number; skipped: 'NOT_CONNECTED' | 'CEILING' | null }`
  - `mirrorFileKey(organizationId, recordId, fileId): string` → `jobber-mirror/<org>/<record>/<file>`

- [ ] **Step 1: Write the failing tests**

`backend/test/jobber-mirror-files.spec.ts`:

```ts
import { JobberConnectionStatus } from '@prisma/client';

import { downloadFile } from '../src/workers/jobber-sync/jobber-invoice-files.worker';
import { JobberMirrorFileWorker, mirrorFileKey } from '../src/workers/jobber-sync/jobber-mirror-files.worker';

jest.mock('../src/workers/jobber-sync/jobber-invoice-files.worker', () => {
  const actual = jest.requireActual('../src/workers/jobber-sync/jobber-invoice-files.worker');
  return { ...actual, downloadFile: jest.fn().mockResolvedValue(Buffer.from('bytes')) };
});

/** Note attachments copied out of Jobber before its links stop working (2026-11-24). Ids invented. */

const ORG = '30000000-0000-4000-8000-000000000001';
const record = { id: 'rec-1', kind: 'JOB', jobberId: 'job-1' };
const link = (id: string) => ({
  id,
  fileName: `${id}.jpg`,
  contentType: 'image/jpeg',
  fileSize: 5,
  url: `https://files.example.com/${id}`,
  downloadUrl: null,
  downloadContentType: null,
});

function setup({ copiedToday = 0, pending = [] as object[] } = {}) {
  const prisma = {
    jobberConnection: { findUnique: jest.fn().mockResolvedValue({ status: JobberConnectionStatus.CONNECTED }) },
    jobberRecord: {
      // Prisma's field reference, used to compare filesListedAt with jobberUpdatedAt.
      fields: { jobberUpdatedAt: 'jobberUpdatedAt' },
      findMany: jest.fn().mockResolvedValueOnce([record]).mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
    jobberRecordFile: {
      count: jest.fn().mockResolvedValue(copiedToday),
      findMany: jest.fn().mockResolvedValue(pending),
      upsert: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const client = { request: jest.fn() };
  const storage = { put: jest.fn().mockResolvedValue(undefined) };
  const worker = new JobberMirrorFileWorker(prisma as never, client as never, storage as never);
  return { prisma, client, storage, worker };
}

beforeEach(() => jest.mocked(downloadFile).mockClear().mockResolvedValue(Buffer.from('bytes')));

it('lists a record\'s attachments, then copies the ones not yet stored into our storage', async () => {
  const { prisma, client, storage, worker } = setup({
    pending: [{ id: 'file-a', recordId: 'rec-1', jobberFileId: 'att-1', contentType: 'image/jpeg', copyAttempts: 0, copyAttemptedAt: null }],
  });
  client.request.mockResolvedValueOnce({ job: { id: 'job-1', noteAttachments: { nodes: [link('att-1')] } } });

  const result = await worker.run(ORG);

  expect(result).toEqual({ listed: 1, copied: 1, failed: 0, skipped: null });
  expect(prisma.jobberRecordFile.upsert).toHaveBeenCalledWith(
    expect.objectContaining({ where: { organizationId_jobberFileId: { organizationId: ORG, jobberFileId: 'att-1' } } }),
  );
  expect(prisma.jobberRecord.update).toHaveBeenCalledWith({ where: { id: 'rec-1' }, data: { filesListedAt: expect.any(Date) } });
  expect(storage.put).toHaveBeenCalledWith(mirrorFileKey(ORG, 'rec-1', 'file-a'), Buffer.from('bytes'), 'image/jpeg');
  // The link is used, never kept.
  expect(JSON.stringify(prisma.jobberRecordFile.update.mock.calls)).not.toContain('files.example.com');
});

it("ends a gone record's files as failed instead of retrying forever", async () => {
  const { prisma, client, worker } = setup({
    pending: [{ id: 'file-a', recordId: 'rec-1', jobberFileId: 'att-1', contentType: null, copyAttempts: 0, copyAttemptedAt: null }],
  });
  client.request.mockResolvedValueOnce({ job: null });

  const result = await worker.run(ORG);

  expect(result.failed).toBe(1);
  expect(prisma.jobberRecordFile.update).toHaveBeenCalledWith({
    where: { id: 'file-a' },
    data: { copyProblem: 'Jobber no longer has this record.', copyAttempts: 5 },
  });
});

it('copies nothing once the daily ceiling is reached', async () => {
  const { client, worker } = setup({ copiedToday: 2_000 });
  expect(await worker.run(ORG)).toEqual({ listed: 0, copied: 0, failed: 0, skipped: 'CEILING' });
  expect(client.request).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx jest test/jobber-mirror-files.spec.ts`
Expected: FAIL — cannot find module `jobber-mirror-files.worker`.

- [ ] **Step 3: Write the file worker**

`backend/src/workers/jobber-sync/jobber-mirror-files.worker.ts`:

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { JobberConnectionStatus, type JobberRecordKind } from '@prisma/client';
import { z } from 'zod';

import { businessDayBounds } from '../../common/business-day';
import { ceilingFrom } from '../../common/daily-allowance';
import { InvoiceFileStorageService } from '../../common/invoice-file-storage.service';
import { PrismaService } from '../../common/prisma.service';
import { MIRROR_KINDS, mirrorFilesQuery, mirrorKind } from '../../integrations/jobber/jobber-mirror.kinds';
import { JobberClient } from '../../integrations/jobber/jobber.client';
import {
  downloadFile,
  dueForCopy,
  FileCopyError,
  MAX_COPY_ATTEMPTS,
  sourceToCopy,
} from './jobber-invoice-files.worker';

/** Records whose attachments are listed in a run, files copied, and how long it may take. */
const RECORDS_PER_RUN = 5;
const FILES_PER_RUN = 15;
const RUN_BUDGET_MS = 60_000;
export const DEFAULT_MIRROR_FILE_CEILING = 2_000;

export const mirrorFileKey = (organizationId: string, recordId: string, fileId: string) =>
  `jobber-mirror/${organizationId}/${recordId}/${fileId}`;

const attachmentSchema = z.object({
  id: z.string(),
  fileName: z.string().nullish(),
  contentType: z.string().nullish(),
  fileSize: z.number().nullish(),
  url: z.string().nullish(),
  downloadUrl: z.string().nullish(),
  downloadContentType: z.string().nullish(),
});
type Attachment = z.infer<typeof attachmentSchema>;

export interface MirrorFileResult {
  listed: number;
  copied: number;
  failed: number;
  skipped: 'NOT_CONNECTED' | 'CEILING' | null;
}

const FILE_KINDS = MIRROR_KINDS.filter((k) => k.hasFiles).map((k) => k.kind);

/**
 * Copies note attachments on mirrored records into our own storage
 * (2026-11-24), a few records a run, after the records themselves.
 *
 * Jobber's links are short-lived and die with the account, so they are asked
 * for at the moment of copying and never kept. Downloading reuses the invoice
 * file copy's guarded `downloadFile` (HTTPS only, size-capped, timed out).
 */
@Injectable()
export class JobberMirrorFileWorker {
  private readonly logger = new Logger(JobberMirrorFileWorker.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(JobberClient) private readonly client: JobberClient,
    @Inject(InvoiceFileStorageService) private readonly storage: InvoiceFileStorageService,
  ) {}

  async run(organizationId: string, clock: () => number = Date.now): Promise<MirrorFileResult> {
    const result: MirrorFileResult = { listed: 0, copied: 0, failed: 0, skipped: null };
    const connection = await this.prisma.jobberConnection.findUnique({ where: { organizationId }, select: { status: true } });
    if (connection?.status !== JobberConnectionStatus.CONNECTED) return { ...result, skipped: 'NOT_CONNECTED' };

    const started = clock();
    const ceiling = ceilingFrom('JOBBER_MIRROR_FILE_DAILY_CEILING', DEFAULT_MIRROR_FILE_CEILING);
    const triedToday = await this.prisma.jobberRecordFile.count({
      where: { organizationId, copyAttemptedAt: { gte: businessDayBounds(new Date(started)).start } },
    });
    if (triedToday >= ceiling) return { ...result, skipped: 'CEILING' };
    let allowance = Math.min(ceiling - triedToday, FILES_PER_RUN);

    for (const record of await this.recordsToVisit(organizationId)) {
      if (allowance <= 0 || clock() - started >= RUN_BUDGET_MS) break;
      const attachments = await this.list(organizationId, record);
      result.listed += 1;
      const pending = await this.prisma.jobberRecordFile.findMany({
        where: { organizationId, recordId: record.id, storageKey: null, copyAttempts: { lt: MAX_COPY_ATTEMPTS } },
        select: { id: true, recordId: true, jobberFileId: true, contentType: true, copyAttempts: true, copyAttemptedAt: true },
      });
      for (const file of pending) {
        if (allowance <= 0 || clock() - started >= RUN_BUDGET_MS) break;
        if (!dueForCopy(file, clock())) continue;
        allowance -= 1;
        if (await this.copy(organizationId, file, attachments)) result.copied += 1;
        else result.failed += 1;
      }
    }
    return result;
  }

  /** Records with attachments never listed or changed since, then records with a file due another try. */
  private async recordsToVisit(organizationId: string) {
    const select = { id: true, kind: true, jobberId: true } as const;
    const unlisted = await this.prisma.jobberRecord.findMany({
      where: {
        organizationId,
        kind: { in: FILE_KINDS },
        deletedInJobberAt: null,
        fileCount: { gt: 0 },
        OR: [{ filesListedAt: null }, { filesListedAt: { lt: this.prisma.jobberRecord.fields.jobberUpdatedAt } }],
      },
      select,
      take: RECORDS_PER_RUN,
    });
    if (unlisted.length >= RECORDS_PER_RUN) return unlisted;
    const retrying = await this.prisma.jobberRecord.findMany({
      where: {
        organizationId,
        id: { notIn: unlisted.map((r) => r.id) },
        files: { some: { storageKey: null, copyAttempts: { gt: 0, lt: MAX_COPY_ATTEMPTS } } },
      },
      select,
      take: RECORDS_PER_RUN - unlisted.length,
    });
    return [...unlisted, ...retrying];
  }

  /** The record's attachments as Jobber has them now, recorded; null when Jobber no longer has the record. */
  private async list(organizationId: string, record: { id: string; kind: JobberRecordKind; jobberId: string }) {
    const spec = mirrorKind(record.kind);
    const data = await this.client.request<Record<string, { noteAttachments: { nodes: unknown[] } } | null>>(
      organizationId,
      mirrorFilesQuery(spec),
      { id: record.jobberId },
    );
    const parent = data[spec.single!];
    if (!parent) return null;
    const attachments = parent.noteAttachments.nodes.map((node) => attachmentSchema.parse(node));
    for (const a of attachments) {
      const meta = { fileName: a.fileName ?? null, contentType: a.contentType ?? null, sizeBytes: a.fileSize ?? null };
      await this.prisma.jobberRecordFile.upsert({
        where: { organizationId_jobberFileId: { organizationId, jobberFileId: a.id } },
        create: { organizationId, recordId: record.id, jobberFileId: a.id, ...meta },
        update: meta,
      });
    }
    await this.prisma.jobberRecord.update({ where: { id: record.id }, data: { filesListedAt: new Date() } });
    return new Map(attachments.map((a) => [a.id, a]));
  }

  /** One file: counted as tried before anything is downloaded, kept once stored. */
  private async copy(
    organizationId: string,
    file: { id: string; recordId: string; jobberFileId: string; contentType: string | null; copyAttempts: number },
    attachments: Map<string, Attachment> | null,
  ) {
    const claimed = await this.prisma.jobberRecordFile.updateMany({
      where: { id: file.id, organizationId, storageKey: null, copyAttempts: file.copyAttempts },
      data: { copyAttempts: { increment: 1 }, copyAttemptedAt: new Date() },
    });
    if (claimed.count !== 1) return false;
    try {
      if (!attachments) throw new FileCopyError('Jobber no longer has this record.', true);
      const link = attachments.get(file.jobberFileId);
      if (!link) throw new FileCopyError('Jobber no longer has this file.', true);
      const source = sourceToCopy({
        url: link.url ?? null,
        contentType: link.contentType ?? null,
        downloadUrl: link.downloadUrl ?? null,
        downloadContentType: link.downloadContentType ?? null,
      });
      const bytes = await downloadFile(source.address);
      const storageKey = mirrorFileKey(organizationId, file.recordId, file.id);
      await this.storage.put(storageKey, bytes, source.contentType || file.contentType || 'application/octet-stream');
      await this.prisma.jobberRecordFile.update({
        where: { id: file.id },
        data: { storageKey, copiedAt: new Date(), copyProblem: null },
      });
      return true;
    } catch (error) {
      const problem = error instanceof FileCopyError ? error.message : 'The file could not be stored.';
      await this.prisma.jobberRecordFile.update({
        where: { id: file.id },
        data: {
          copyProblem: problem,
          ...(error instanceof FileCopyError && error.final ? { copyAttempts: MAX_COPY_ATTEMPTS } : {}),
        },
      });
      this.logger.warn({ event: 'jobber_mirror_file_not_copied', organizationId, fileId: file.id, problem });
      return false;
    }
  }
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `npx jest test/jobber-mirror-files.spec.ts`
Expected: PASS (3 tests). If `MAX_COPY_ATTEMPTS` is not 5, change the test's `copyAttempts: 5` to the imported constant.

- [ ] **Step 5: Commit**

```bash
git add src/workers/jobber-sync/jobber-mirror-files.worker.ts test/jobber-mirror-files.spec.ts
git commit -m "feat(jobber): note attachments on mirrored records are copied into our storage before Jobber's links stop working"
```

---

### Task 6: Wiring — scheduler, webhook, status endpoint

**Files:**
- Create: `backend/src/integrations/jobber/jobber-mirror.service.ts`
- Modify: `backend/src/integrations/jobber/jobber.module.ts` (providers list, ~line 30-50)
- Modify: `backend/src/workers/jobber-sync/jobber-sync.scheduler.ts` (constructor ~line 36; end of `tick`, inside the invoice `try` before `finally`)
- Modify: `backend/src/integrations/jobber/jobber.webhook.service.ts` (constructor line 34; `VISIT_DESTROY` branch line ~113)
- Modify: `backend/src/integrations/jobber/jobber.controller.ts` (constructor line 50; new route next to `visit-imports`)
- Test: `backend/test/jobber-mirror-status.spec.ts`

**Interfaces:**
- Consumes: `JobberMirrorWorker.run`, `JobberMirrorFileWorker.run` (Tasks 4-5); `MIRROR_KINDS`; `MAX_COPY_ATTEMPTS`; `AuthenticatedUser` (`organizationId`).
- Produces:
  - `JobberMirrorService.status(user): Promise<{ kinds: MirrorKindStatus[] }>`
  - `interface MirrorKindStatus { kind; records: number; deleted: number; extractFailed: number; filesStored: number; filesPending: number; filesFailed: number; walkCompletedAt: Date | null; walkInProgress: boolean; lastCheckedAt: Date | null; lastError: string | null; lastErrorAt: Date | null }`
  - `JobberMirrorService.markVisitDeleted(organizationId, jobberVisitId): Promise<void>`
  - `GET /integrations/jobber/mirror` (`integrations:read`)

- [ ] **Step 1: Write the failing test**

`backend/test/jobber-mirror-status.spec.ts`:

```ts
import { JobberMirrorService } from '../src/integrations/jobber/jobber-mirror.service';

/** How far the copy has got, for the office to check before Jobber is closed (2026-11-24). */

const ORG = '30000000-0000-4000-8000-000000000001';
const user = { id: 'user-1', organizationId: ORG } as never;

function setup() {
  const prisma = {
    jobberRecord: {
      groupBy: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if ('deletedInJobberAt' in where && where.deletedInJobberAt === null && !('extractFailed' in where))
          return [{ kind: 'JOB', _count: { _all: 120 } }];
        if ('extractFailed' in where) return [{ kind: 'JOB', _count: { _all: 2 } }];
        return [{ kind: 'JOB', _count: { _all: 3 } }];
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    jobberRecordFile: { findMany: jest.fn().mockResolvedValue([
      { storageKey: 'k', copyAttempts: 1, record: { kind: 'JOB' } },
      { storageKey: null, copyAttempts: 1, record: { kind: 'JOB' } },
      { storageKey: null, copyAttempts: 5, record: { kind: 'JOB' } },
    ]) },
    jobberMirrorCursor: { findMany: jest.fn().mockResolvedValue([
      { kind: 'JOB', walkCompletedAt: null, walkCursor: 'c-1', lastCheckedAt: null, lastError: null, lastErrorAt: null },
    ]) },
  };
  return { prisma, service: new JobberMirrorService(prisma as never) };
}

it('reports every kind, with records, deletions, unreadable rows and files, scoped to the organization', async () => {
  const { prisma, service } = setup();

  const { kinds } = await service.status(user);

  expect(kinds.map((k) => k.kind)).toEqual(['CLIENT', 'PROPERTY', 'JOB', 'VISIT', 'QUOTE', 'REQUEST']);
  expect(kinds.find((k) => k.kind === 'JOB')).toEqual({
    kind: 'JOB',
    records: 120,
    deleted: 3,
    extractFailed: 2,
    filesStored: 1,
    filesPending: 1,
    filesFailed: 1,
    walkCompletedAt: null,
    walkInProgress: true,
    lastCheckedAt: null,
    lastError: null,
    lastErrorAt: null,
  });
  for (const [call] of prisma.jobberRecord.groupBy.mock.calls) expect(call.where.organizationId).toBe(ORG);
});

it('marks a visit Jobber deleted, never erasing it', async () => {
  const { prisma, service } = setup();
  await service.markVisitDeleted(ORG, 'visit-1');
  expect(prisma.jobberRecord.updateMany).toHaveBeenCalledWith({
    where: { organizationId: ORG, kind: 'VISIT', jobberId: 'visit-1', deletedInJobberAt: null },
    data: { deletedInJobberAt: expect.any(Date) },
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx jest test/jobber-mirror-status.spec.ts`
Expected: FAIL — cannot find module `jobber-mirror.service`.

- [ ] **Step 3: Write the service**

`backend/src/integrations/jobber/jobber-mirror.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { JobberRecordKind } from '@prisma/client';

import type { AuthenticatedUser } from '../../common/auth';
import { PrismaService } from '../../common/prisma.service';
import { MAX_COPY_ATTEMPTS } from '../../workers/jobber-sync/jobber-invoice-files.worker';
import { MIRROR_KINDS } from './jobber-mirror.kinds';

export interface MirrorKindStatus {
  kind: JobberRecordKind;
  records: number;
  deleted: number;
  extractFailed: number;
  filesStored: number;
  filesPending: number;
  filesFailed: number;
  walkCompletedAt: Date | null;
  walkInProgress: boolean;
  lastCheckedAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
}

/**
 * How complete the Jobber copy is (2026-11-24): what the office checks before
 * the Jobber account is closed. Counts and error codes only, never payloads.
 */
@Injectable()
export class JobberMirrorService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async status(user: AuthenticatedUser): Promise<{ kinds: MirrorKindStatus[] }> {
    const organizationId = user.organizationId;
    const count = (rows: { kind: JobberRecordKind; _count: { _all: number } }[]) =>
      new Map(rows.map((row) => [row.kind, row._count._all]));
    const [live, deleted, unreadable, files, cursors] = await Promise.all([
      this.prisma.jobberRecord.groupBy({ by: ['kind'], where: { organizationId, deletedInJobberAt: null }, _count: { _all: true } }),
      this.prisma.jobberRecord.groupBy({ by: ['kind'], where: { organizationId, deletedInJobberAt: { not: null } }, _count: { _all: true } }),
      this.prisma.jobberRecord.groupBy({ by: ['kind'], where: { organizationId, extractFailed: true }, _count: { _all: true } }),
      this.prisma.jobberRecordFile.findMany({
        where: { organizationId },
        select: { storageKey: true, copyAttempts: true, record: { select: { kind: true } } },
      }),
      this.prisma.jobberMirrorCursor.findMany({ where: { organizationId } }),
    ]);
    const [liveBy, deletedBy, unreadableBy] = [count(live as never), count(deleted as never), count(unreadable as never)];

    return {
      kinds: MIRROR_KINDS.map(({ kind }) => {
        const mine = files.filter((f) => f.record.kind === kind);
        const cursor = cursors.find((c) => c.kind === kind);
        return {
          kind,
          records: liveBy.get(kind) ?? 0,
          deleted: deletedBy.get(kind) ?? 0,
          extractFailed: unreadableBy.get(kind) ?? 0,
          filesStored: mine.filter((f) => f.storageKey).length,
          filesPending: mine.filter((f) => !f.storageKey && f.copyAttempts < MAX_COPY_ATTEMPTS).length,
          filesFailed: mine.filter((f) => !f.storageKey && f.copyAttempts >= MAX_COPY_ATTEMPTS).length,
          walkCompletedAt: cursor?.walkCompletedAt ?? null,
          walkInProgress: Boolean(cursor?.walkCursor),
          lastCheckedAt: cursor?.lastCheckedAt ?? null,
          lastError: cursor?.lastError ?? null,
          lastErrorAt: cursor?.lastErrorAt ?? null,
        };
      }),
    };
  }

  /** VISIT_DESTROY: the copy keeps the visit, marked gone. */
  async markVisitDeleted(organizationId: string, jobberVisitId: string) {
    await this.prisma.jobberRecord.updateMany({
      where: { organizationId, kind: JobberRecordKind.VISIT, jobberId: jobberVisitId, deletedInJobberAt: null },
      data: { deletedInJobberAt: new Date() },
    });
  }
}
```

Note: the files list loads one small row per attachment. That is a few thousand rows at most for this account; if it grows past ~50,000, replace with a raw `GROUP BY` query.

- [ ] **Step 4: Run it to see it pass**

Run: `npx jest test/jobber-mirror-status.spec.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire it in**

`jobber.module.ts` — imports at the top:

```ts
import { JobberMirrorFileWorker } from '../../workers/jobber-sync/jobber-mirror-files.worker';
import { JobberMirrorWorker } from '../../workers/jobber-sync/jobber-mirror.worker';
import { JobberMirrorService } from './jobber-mirror.service';
```

and in `providers`, after `JobberInvoiceFileWorker,`:

```ts
    JobberMirrorWorker,
    JobberMirrorFileWorker,
    JobberMirrorService,
```

`jobber-sync.scheduler.ts` — imports:

```ts
import { JobberMirrorFileWorker } from './jobber-mirror-files.worker';
import { JobberMirrorWorker } from './jobber-mirror.worker';
```

constructor, after the `invoiceFiles` parameter:

```ts
    @Inject(JobberMirrorWorker) private readonly mirror: JobberMirrorWorker,
    @Inject(JobberMirrorFileWorker) private readonly mirrorFiles: JobberMirrorFileWorker,
```

In `tick`, replace the trailing

```ts
    } catch (error) {
      this.logger.error(
        `Jobber invoice read failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    } finally {
      this.running = false;
    }
```

with

```ts
    } catch (error) {
      this.logger.error(
        `Jobber invoice read failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
    // The read-only copy of every Jobber record (2026-11-24): last on the tick,
    // so visits, the outbox and invoices always have the bucket first.
    if (this.config.mirrorEnabled) {
      try {
        const mirrored = await withTenant(organizationId, () => this.mirror.run(organizationId));
        if (mirrored.pages || mirrored.kinds.some((k) => k.problem))
          this.logger.log(
            `Jobber mirror: ${mirrored.pages} pages; ` +
              mirrored.kinds
                .map((k) => `${k.kind} ${k.mode} ${k.saved} saved${k.caughtUp ? ', caught up' : ''}${k.problem ? `, ${k.problem}` : ''}`)
                .join('; ') +
              '.',
          );
        if (!mirrored.skipped && !mirrored.kinds.some((k) => k.problem === 'THROTTLED')) {
          const files = await withTenant(organizationId, () => this.mirrorFiles.run(organizationId));
          if (files.copied || files.failed)
            this.logger.log(`Jobber mirror files: ${files.copied} copied, ${files.failed} not copied.`);
        }
      } catch (error) {
        this.logger.error(`Jobber mirror failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      }
    }
    this.running = false;
```

Every block before it, and the mirror block itself, catches everything it throws, so the closing `this.running = false;` always runs — the same guarantee the removed `finally` gave.

`jobber.webhook.service.ts` — import `JobberMirrorService` from `./jobber-mirror.service`; constructor gets
`@Inject(JobberMirrorService) private readonly mirror: JobberMirrorService,`; in the `VISIT_DESTROY` branch, after `withdrawDeletedVisit`:

```ts
        await this.mirror.markVisitDeleted(connection.organizationId, event.itemId);
```

`jobber.controller.ts` — import `JobberMirrorService`; constructor gets `private readonly mirror: JobberMirrorService,`; route after `visitImports`:

```ts
  /** How complete the read-only copy of Jobber is, per kind (2026-11-24). */
  @Get('mirror')
  @RequirePermissions('integrations:read')
  mirrorStatus(@Req() request: AuthenticatedRequest) {
    return this.mirror.status(request.user);
  }
```

- [ ] **Step 6: Type-check and run the mirror specs plus the Jobber specs the wiring touches**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.
Run: `npx jest test/jobber-mirror test/jobber-webhook test/jobber-invoice-worker.spec.ts`
Expected: PASS. (Jest treats each argument as a path pattern, so `test/jobber-mirror` runs all five mirror specs.)

- [ ] **Step 7: Commit**

```bash
git add src/integrations/jobber/jobber-mirror.service.ts src/integrations/jobber/jobber.module.ts src/workers/jobber-sync/jobber-sync.scheduler.ts src/integrations/jobber/jobber.webhook.service.ts src/integrations/jobber/jobber.controller.ts test/jobber-mirror-status.spec.ts
git commit -m "feat(jobber): the mirror runs last on the sync tick when JOBBER_MIRROR_ENABLED, a deleted visit is marked, and the office can see how complete the copy is"
```

---

### Task 7: Turning it on (server, by the office)

- [ ] **Step 1: Document the switch** — add to `backend/.env.example` (next to `JOBBER_SYNC_ENABLED`):

```
# Read-only copy of every Jobber record (clients, properties, jobs, visits,
# quotes, requests, notes, attachments). Runs on the Jobber sync tick.
JOBBER_MIRROR_ENABLED=false
# Attachments copied per business day at most.
JOBBER_MIRROR_FILE_DAILY_CEILING=2000
```

Commit: `git commit -am "docs(jobber): the mirror's switch and file ceiling in .env.example"`

- [ ] **Step 2: STOP — hand over to the user** to deploy, run `prisma migrate deploy`, set `JOBBER_MIRROR_ENABLED=true` on the server, and watch `GET /integrations/jobber/mirror` until every kind shows `walkCompletedAt` and no `lastError`.

---

## Probe result

_(Pasted here after Task 1, Step 4. Task 3's selections are corrected to match.)_
