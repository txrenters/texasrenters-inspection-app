/**
 * One day, as the console has it and as Jobber last told the sync -- side by
 * side, with the reason for every difference. Read-only.
 *
 * Written for 2026-10-01, when Moses's day showed seven stops in the console
 * and six in Jobber: three visits the office had moved off the day in Jobber
 * stayed on it here. Run it for any day a technician's two calendars disagree.
 *
 *   node scripts/jobber-day-check.mjs --date 2026-10-01 --technician moses
 *
 * Options
 *   --date YYYY-MM-DD    the Texas day to check (required)
 *   --technician TEXT    only this technician: part of a name or an email
 *
 * "What Jobber said" is the copy the sync stored the last time it saw the
 * visit, and when that was -- not a live call to Jobber, so nothing here needs
 * the Jobber token and nothing is written anywhere.
 */
import { ownerPrismaClient } from './owner-prisma.mjs';

const argv = process.argv.slice(2);
const value = (name) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : undefined;
};

const date = value('date');
if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error('Use --date YYYY-MM-DD');
  process.exit(1);
}
const technician = value('technician')?.toLowerCase() ?? null;

// The switches as the backend reads them (jobber.config.ts), true or false only.
const bookingEnabled = process.env.JOBBER_BOOKING_ENABLED === 'true';
const pushEditsEnabled =
  process.env.JOBBER_PUSH_EDITS_ENABLED === undefined
    ? bookingEnabled
    : process.env.JOBBER_PUSH_EDITS_ENABLED === 'true';

/** A Texas day in UTC: 05:00Z to 05:00Z while daylight saving lasts, 06:00Z after. */
function texasDayBounds(day) {
  const noon = new Date(`${day}T12:00:00Z`);
  const offset = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', timeZoneName: 'shortOffset' })
    .formatToParts(noon)
    .find((part) => part.type === 'timeZoneName')
    .value.replace('GMT', '');
  const hours = -Number(offset || 0);
  const start = new Date(`${day}T00:00:00Z`);
  start.setUTCHours(hours);
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

const texasDay = (iso) =>
  iso ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(iso)) : null;
const ago = (at) => {
  if (!at) return 'never';
  const minutes = Math.round((Date.now() - new Date(at).getTime()) / 60_000);
  return minutes < 90 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
};
const assigneesOf = (payload) =>
  (payload?.assignedUsers?.nodes ?? []).map((user) => user.name?.full ?? user.email?.raw ?? user.id);

const prisma = ownerPrismaClient();
try {
  const connection = await prisma.jobberConnection.findFirst({
    select: {
      organizationId: true,
      status: true,
      lastSyncStartedAt: true,
      lastSyncCompletedAt: true,
      lastSyncError: true,
      lastSyncVisitCount: true,
    },
  });
  if (!connection) throw new Error('No Jobber connection.');
  const organizationId = connection.organizationId;
  const since = new Date(Date.now() - 86_400_000);
  const webhooks = await prisma.webhookEvent.groupBy({
    by: ['status'],
    where: { provider: 'jobber', createdAt: { gte: since } },
    _count: true,
  });

  console.log(`\nJobber, as of ${new Date().toISOString()}`);
  console.log(`  connection         ${connection.status}`);
  console.log(`  last sync          started ${ago(connection.lastSyncStartedAt)}, finished ${ago(connection.lastSyncCompletedAt)}, ${connection.lastSyncVisitCount ?? 0} visits`);
  if (connection.lastSyncError) console.log(`  last sync error    ${connection.lastSyncError}`);
  console.log(`  webhooks, 24 h     ${webhooks.map((row) => `${row.status} ${row._count}`).join(', ') || 'none'}`);
  console.log(`  console edits sent to Jobber (JOBBER_PUSH_EDITS_ENABLED): ${pushEditsEnabled ? 'ON' : 'OFF'}`);

  const inspections = await prisma.inspection.findMany({
    where: { organizationId, scheduledAt: new Date(`${date}T00:00:00Z`), status: { not: 'CANCELLED' } },
    select: {
      id: true,
      status: true,
      source: true,
      inspectionType: true,
      jobberVisitId: true,
      jobberVisitTitle: true,
      propertywareBuilding: { select: { addressLine1: true, name: true } },
      assignments: {
        where: { isCurrent: true },
        select: { technician: { select: { displayName: true, email: true } } },
      },
      jobberOutboundTasks: {
        where: { status: { in: ['PENDING', 'FAILED', 'ABANDONED'] } },
        select: { kind: true, status: true, attempts: true, lastError: true, createdAt: true },
      },
    },
    orderBy: { id: 'asc' },
  });
  const mine = inspections.filter((row) => {
    if (!technician) return true;
    const person = row.assignments[0]?.technician;
    return Boolean(person && `${person.displayName} ${person.email}`.toLowerCase().includes(technician));
  });
  const imports = await prisma.jobberVisitImport.findMany({
    where: { organizationId, jobberVisitId: { in: mine.map((row) => row.jobberVisitId).filter(Boolean) } },
    select: { jobberVisitId: true, status: true, failureCode: true, payload: true, lastAttemptAt: true },
  });
  const importOf = new Map(imports.map((row) => [row.jobberVisitId, row]));

  console.log(`\nIn the console on ${date}${technician ? ` for "${technician}"` : ''}: ${mine.length}`);
  for (const row of mine) {
    const address = row.propertywareBuilding?.addressLine1 ?? row.propertywareBuilding?.name ?? '(no property)';
    const record = row.jobberVisitId ? importOf.get(row.jobberVisitId) : null;
    const jobberDay = record?.payload ? (record.payload.startAt ? texasDay(record.payload.startAt) : 'no day (Unscheduled)') : null;
    const waiting = row.jobberOutboundTasks.filter((task) => task.status !== 'ABANDONED');
    let verdict;
    if (!row.jobberVisitId) verdict = `NOT IN JOBBER: made here (${row.source}); no Jobber visit is linked.`;
    else if (waiting.some((task) => ['VISIT_RESCHEDULE', 'VISIT_CANCEL'].includes(task.kind)))
      verdict = pushEditsEnabled
        ? 'HELD: a console change is waiting to be sent to Jobber; Jobber\'s day is held back until it goes.'
        : 'HELD FOR GOOD: a console change that can never be sent (pushes are off) is holding Jobber\'s day back.';
    else if (jobberDay && jobberDay !== date) verdict = `DIFFERS: Jobber last said ${jobberDay}.`;
    else if (record?.lastAttemptAt && Date.now() - new Date(record.lastAttemptAt).getTime() > 3_600_000)
      verdict = `GONE FROM JOBBER? The sync has not seen this visit for ${ago(record.lastAttemptAt).replace(' ago', '')}: deleted or moved to Unscheduled.`;
    else verdict = 'In step with Jobber.';
    console.log(`\n  ${address} -- ${row.inspectionType}, ${row.status}, ${row.assignments[0]?.technician.displayName ?? 'unassigned'}`);
    if (row.jobberVisitTitle) console.log(`    Jobber title     ${row.jobberVisitTitle}`);
    if (record) console.log(`    Jobber, last seen ${ago(record.lastAttemptAt)}: ${jobberDay ?? '?'}${record.failureCode ? ` [${record.failureCode}]` : ''}`);
    for (const task of row.jobberOutboundTasks)
      console.log(`    console change   ${task.kind} ${task.status}, ${task.attempts} tries, queued ${ago(task.createdAt)}${task.lastError ? ` -- ${task.lastError}` : ''}`);
    console.log(`    => ${verdict}`);
  }

  // Jobber visits on the day that are not an inspection here, and why.
  const { start, end } = texasDayBounds(date);
  const onTheDay = await prisma.$queryRaw`
    SELECT "jobberVisitId", status::text AS status, "failureMessage", payload, "inspectionId"
    FROM "JobberVisitImport"
    WHERE "organizationId" = ${organizationId}::uuid
      AND payload->>'startAt' >= ${start.toISOString()} AND payload->>'startAt' < ${end.toISOString()}`;
  const linked = new Set(mine.map((row) => row.jobberVisitId));
  const others = onTheDay.filter(
    (row) =>
      !linked.has(row.jobberVisitId) &&
      (!technician || assigneesOf(row.payload).join(' ').toLowerCase().includes(technician)),
  );
  console.log(`\nIn Jobber on ${date} (as last seen) but not an inspection here on that day: ${others.length}`);
  for (const row of others) {
    const street = row.payload?.property?.address?.street1 ?? '(no property)';
    const why =
      row.status === 'IMPORTED'
        ? 'its inspection is on another day here, or cancelled'
        : `${row.status}${row.failureMessage ? `: ${row.failureMessage}` : ''}`;
    console.log(`  ${street} -- "${row.payload?.title ?? ''}" -- ${why}`);
  }
  console.log('');
} finally {
  await prisma.$disconnect();
}
