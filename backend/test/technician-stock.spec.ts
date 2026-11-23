import { ValidationPipe } from '@nestjs/common';
import { UserRole, type PostStockSlipInput, type RecordJobStockInput } from '@texasrenters/shared';

import type { AuthenticatedUser } from '../src/common/auth';
import { ApplicationError } from '../src/common/errors';
import { AskForTruckStockDto, RecordJobStockDto, TechnicianStockController } from '../src/technician/technician-stock.controller';
import { TechnicianStockService } from '../src/technician/technician-stock.service';

/**
 * A job's materials on the phone, phase 7 (2026-11-19). Every id, name and
 * code here is invented. The posting itself is the office's and is covered by
 * stock-slips.spec.ts: here it is a stand-in that keeps what it was asked to
 * post, so these cover what the phone may and may not ask for.
 */

const ORG = 'a0000000-0000-4000-8000-000000000001';
const OTHER_ORG = 'a0000000-0000-4000-8000-000000000002';
const id = (n: number) => `a0000000-0000-4000-8000-${String(1000 + n).padStart(12, '0')}`;
const FILTER = id(1);
const BATTERY = id(2);
const STOCKROOM = id(11);
const MY_TRUCK = id(12);
const SHARED_TRUCK = id(13);
const THEIR_TRUCK = id(14);
const PARKED_TRUCK = id(15);
const JOB = id(31);
const OTHER_JOB = id(32);
const CANCELLED_JOB = id(33);
const THEIR_JOB = id(34);

const technician = (n: number, displayName: string, organizationId = ORG): AuthenticatedUser =>
  ({ id: id(800 + n), authUserId: `auth-${n}`, organizationId, displayName, roles: [UserRole.INSPECTION_TECHNICIAN], permissions: [], mustChangePassword: false, principalType: 'USER' }) as AuthenticatedUser;
const ana = technician(1, 'Ana Sample');
const ben = technician(2, 'Ben Sample');
const stranger = technician(3, 'Other Office', OTHER_ORG);

type Row = Record<string, unknown>;

function harness() {
  const items = new Map<string, Row>([
    [FILTER, { id: FILTER, code: 'FLT-0003', name: 'Filter 20x25x1', unit: 'each' }],
    [BATTERY, { id: BATTERY, code: 'PRT-0001', name: 'Battery, 9 V', unit: 'each' }],
  ]);
  const places: Row[] = [
    { id: STOCKROOM, organizationId: ORG, name: 'Storeroom', nameKey: 'storeroom', kind: 'STOCKROOM', technicianId: null, active: true },
    { id: MY_TRUCK, organizationId: ORG, name: 'Truck 1', nameKey: 'truck 1', kind: 'VAN', technicianId: ana.id, active: true },
    { id: SHARED_TRUCK, organizationId: ORG, name: 'Shared truck', nameKey: 'shared truck', kind: 'VAN', technicianId: null, active: true },
    { id: THEIR_TRUCK, organizationId: ORG, name: 'Truck 2', nameKey: 'truck 2', kind: 'VAN', technicianId: ben.id, active: true },
    { id: PARKED_TRUCK, organizationId: ORG, name: 'Old truck', nameKey: 'old truck', kind: 'VAN', technicianId: ana.id, active: false },
  ];
  const levels: Row[] = [
    { organizationId: ORG, placeId: MY_TRUCK, itemId: FILTER, quantity: 10 },
    { organizationId: ORG, placeId: MY_TRUCK, itemId: BATTERY, quantity: 0 },
    { organizationId: ORG, placeId: SHARED_TRUCK, itemId: BATTERY, quantity: 6 },
    { organizationId: ORG, placeId: STOCKROOM, itemId: FILTER, quantity: 40 },
    { organizationId: ORG, placeId: THEIR_TRUCK, itemId: FILTER, quantity: 3 },
  ];
  const jobs: Row[] = [
    { id: JOB, organizationId: ORG, status: 'IN_PROGRESS', technicianId: ana.id },
    { id: OTHER_JOB, organizationId: ORG, status: 'SCHEDULED', technicianId: ana.id },
    { id: CANCELLED_JOB, organizationId: ORG, status: 'CANCELLED', technicianId: ana.id },
    { id: THEIR_JOB, organizationId: ORG, status: 'SCHEDULED', technicianId: ben.id },
  ];
  const slips: Row[] = [];
  const posted: { user: AuthenticatedUser; input: PostStockSlipInput }[] = [];
  // What the office keeps on Truck 1 (2026-11-24): the filters are running low, the batteries ran out.
  const keeps: Row[] = [
    { placeId: MY_TRUCK, itemId: FILTER, keepAtLeast: 12 },
    { placeId: MY_TRUCK, itemId: BATTERY, keepAtLeast: 4 },
  ];
  const asks: Row[] = [];
  const askLines: Row[] = [];
  const audits: Row[] = [];
  let clock = Date.parse('2026-11-19T15:00:00.000Z');

  const prisma = {
    inspection: {
      findFirst: jest.fn(async ({ where }: { where: { id: string; organizationId: string; status: { not: string }; assignments: { some: { technicianId: string; isCurrent: boolean } } } }) =>
        jobs.find((job) => job.id === where.id && job.organizationId === where.organizationId && job.status !== where.status.not && job.technicianId === where.assignments.some.technicianId && where.assignments.some.isCurrent) ?? null,
      ),
    },
    stockPlace: {
      findMany: jest.fn(async ({ where, select }: { where: { organizationId: string; active: boolean; kind: string; OR: { technicianId: string | null }[] }; select: { technicianId?: boolean } }) =>
        places
          .filter((place) => place.organizationId === where.organizationId && place.active === where.active && place.kind === where.kind && where.OR.some((rule) => place.technicianId === rule.technicianId))
          // Their own first, as the service asks.
          .sort((left, right) => Number(left.technicianId === null) - Number(right.technicianId === null))
          .map((place) => ({ id: place.id, name: place.name, ...(select.technicianId ? { technicianId: place.technicianId } : {}) })),
      ),
    },
    stockLevel: {
      findMany: jest.fn(async ({ where }: { where: { organizationId: string; placeId: { in: string[] }; quantity: { gt: number } } }) =>
        levels
          .filter((level) => level.organizationId === where.organizationId && where.placeId.in.includes(level.placeId as string) && (level.quantity as number) > where.quantity.gt)
          .map((level) => ({ placeId: level.placeId, quantity: level.quantity, item: items.get(level.itemId as string) })),
      ),
    },
    stockSlip: {
      findFirst: jest.fn(async ({ where }: { where: { organizationId: string; requestKey: string } }) => slips.find((slip) => slip.organizationId === where.organizationId && slip.requestKey === where.requestKey) ?? null),
      findMany: jest.fn(async ({ where }: { where: { organizationId: string; inspectionId?: string; technicianId: string } }) =>
        slips.filter((slip) => slip.organizationId === where.organizationId && (where.inspectionId === undefined || slip.inspectionId === where.inspectionId) && slip.technicianId === where.technicianId).reverse(),
      ),
    },
    // Every item in use, for the phone's search and scans (2026-11-24); by id when an ask is checked.
    stockItem: {
      findMany: jest.fn(async ({ where }: { where: { id?: { in: string[] } } }) => [...items.values()].filter((item) => !where.id || where.id.in.includes(item.id as string)).map((item) => ({ ...item }))),
    },
    // What the office keeps on each truck, and when each was last counted.
    stockKeepLevel: {
      findMany: jest.fn(async ({ where }: { where: { placeId: { in: string[] } } }) => keeps.filter((keep) => where.placeId.in.includes(keep.placeId as string)).map((keep) => ({ placeId: keep.placeId, keepAtLeast: keep.keepAtLeast, item: items.get(keep.itemId as string) }))),
    },
    stockCount: { groupBy: jest.fn(async () => [{ placeId: MY_TRUCK, _max: { day: new Date('2026-11-02') } }]) },
    truckStockAsk: {
      findFirst: jest.fn(async ({ where }: { where: { requestKey: string } }) => asks.find((ask) => ask.requestKey === where.requestKey) ?? null),
      count: jest.fn(async ({ where }: { where: { placeId: string; status: string } }) => asks.filter((ask) => ask.placeId === where.placeId && ask.status === where.status).length),
      findMany: jest.fn(async ({ where }: { where: { askedById: string; placeId: { in: string[] } } }) =>
        asks
          .filter((ask) => ask.askedById === where.askedById && where.placeId.in.includes(ask.placeId as string))
          .reverse()
          .map((ask) => ({
            ...ask,
            place: { id: ask.placeId, name: places.find((place) => place.id === ask.placeId)!.name },
            askedBy: { id: ask.askedById, displayName: 'Ana Sample' },
            filledSlip: null,
            lines: askLines.filter((line) => line.askId === ask.id).map((line) => ({ quantity: line.quantity, item: items.get(line.itemId as string) })),
          })),
      ),
      create: jest.fn(async ({ data }: { data: Row }) => {
        const row = { id: id(600 + asks.length), status: 'ASKED', createdAt: new Date((clock += 60_000)), filledAt: null, filledByName: null, ...data };
        asks.push(row);
        return row;
      }),
    },
    truckStockAskLine: { createMany: jest.fn(async ({ data }: { data: Row[] }) => askLines.push(...data)) },
    auditLog: { create: jest.fn(async ({ data }: { data: Row }) => audits.push(data)) },
  };
  Object.assign(prisma, { $transaction: jest.fn(async (work: (tx: unknown) => Promise<unknown>): Promise<unknown> => work(prisma)) });
  /** The office's posting, standing in: it keeps the slip, and takes from or adds to the truck as the ledger would. */
  const write = jest.fn(async (user: AuthenticatedUser, input: PostStockSlipInput) => {
    posted.push({ user, input });
    const placeId = (input.fromPlaceId ?? input.toPlaceId)!;
    for (const line of input.lines) {
      const level = levels.find((one) => one.placeId === placeId && one.itemId === line.itemId)!;
      level.quantity = (level.quantity as number) + (input.kind === 'RETURN' ? line.quantity : -line.quantity);
    }
    slips.push({
      id: id(100 + slips.length),
      organizationId: user.organizationId,
      number: `${input.kind === 'RETURN' ? 'RT' : 'WD'}-${String(slips.length + 1).padStart(4, '0')}`,
      kind: input.kind,
      createdAt: new Date((clock += 60_000)),
      reversedAt: null,
      requestKey: input.requestKey,
      inspectionId: input.inspectionId,
      technicianId: input.technicianId,
      fromPlace: input.fromPlaceId ? { name: places.find((place) => place.id === input.fromPlaceId)!.name } : null,
      toPlace: input.toPlaceId ? { name: places.find((place) => place.id === input.toPlaceId)!.name } : null,
      lines: input.lines.map((line) => ({ quantity: line.quantity, item: items.get(line.itemId) })),
      inspection: input.inspectionId ? { id: input.inspectionId, propertywareBuilding: null, property: { addressLine1: '12 Sample Ln' } } : null,
    });
  });
  const service = new TechnicianStockService(prisma as never, { write } as never);
  return { service, write, posted, slips, levels, asks, askLines, audits, keeps };
}

const take = (over: Partial<RecordJobStockInput> = {}): RecordJobStockInput => ({ kind: 'WITHDRAWAL', placeId: MY_TRUCK, lines: [{ itemId: FILTER, quantity: 2 }], clientRequestId: 'phone-key-0001', ...over });
const bringBack = (over: Partial<RecordJobStockInput> = {}) => take({ kind: 'RETURN', clientRequestId: 'phone-key-0002', lines: [{ itemId: FILTER, quantity: 1 }], ...over });

describe('what the phone is shown', () => {
  it('lists the trucks a technician may use -- their own first, and one nobody is named on -- and what is in them', async () => {
    const { service } = harness();
    const stock = await service.forJob(ana, JOB);
    // Never the storeroom, another technician's truck, or one no longer in use.
    expect(stock.places).toEqual([{ id: MY_TRUCK, name: 'Truck 1' }, { id: SHARED_TRUCK, name: 'Shared truck' }]);
    // Only what is there: a truck's empty shelf is not offered.
    expect(stock.stock).toEqual([
      { placeId: MY_TRUCK, itemId: FILTER, code: 'FLT-0003', name: 'Filter 20x25x1', unit: 'each', quantity: 10 },
      { placeId: SHARED_TRUCK, itemId: BATTERY, code: 'PRT-0001', name: 'Battery, 9 V', unit: 'each', quantity: 6 },
    ]);
    expect(stock.slips).toEqual([]);
    expect(stock.taken).toEqual([]);
    // What anything cost is the office's.
    expect(JSON.stringify(stock)).not.toMatch(/cost|cents/i);
  });

  it('is for a job of their own, now, that has not been cancelled', async () => {
    const { service } = harness();
    for (const job of [THEIR_JOB, CANCELLED_JOB, id(999)]) await expect(service.forJob(ana, job)).rejects.toMatchObject({ status: 404, code: 'ASSIGNED_INSPECTION_NOT_FOUND' });
    await expect(service.forJob(stranger, JOB)).rejects.toMatchObject({ status: 404 });
    await expect(service.forJob(ben, THEIR_JOB)).resolves.toMatchObject({ places: [{ id: THEIR_TRUCK, name: 'Truck 2' }, { id: SHARED_TRUCK, name: 'Shared truck' }] });
  });
});

describe('taking stock for a job', () => {
  it('posts the office\'s own withdrawal: this technician, this job, from the truck', async () => {
    const { service, posted } = harness();
    const stock = await service.record(ana, JOB, take());

    expect(posted).toHaveLength(1);
    expect(posted[0]!.user).toBe(ana);
    expect(posted[0]!.input).toEqual({ kind: 'WITHDRAWAL', technicianId: ana.id, fromPlaceId: MY_TRUCK, toPlaceId: null, inspectionId: JOB, note: null, requestKey: `phone:${ana.id}:phone-key-0001`, lines: [{ itemId: FILTER, quantity: 2 }], askId: null });
    expect(stock.slips).toEqual([{ id: expect.any(String), number: 'WD-0001', kind: 'WITHDRAWAL', at: expect.any(String), place: 'Truck 1', reversed: false, lines: [{ itemId: FILTER, code: 'FLT-0003', name: 'Filter 20x25x1', unit: 'each', quantity: 2 }] }]);
    expect(stock.taken).toEqual([expect.objectContaining({ itemId: FILTER, quantity: 2 })]);
    expect(stock.stock.find((item) => item.itemId === FILTER)!.quantity).toBe(8);
  });

  it('records once however many times the phone sends it, and never moves a key to another job', async () => {
    const { service, write } = harness();
    await service.record(ana, JOB, take());
    await expect(service.record(ana, JOB, take())).resolves.toMatchObject({ taken: [expect.objectContaining({ quantity: 2 })] });
    expect(write).toHaveBeenCalledTimes(1);
    await expect(service.record(ana, OTHER_JOB, take())).rejects.toMatchObject({ status: 409, code: 'CLIENT_REQUEST_ID_REUSED' });
    // Another technician's phone made the same letters: it is another slip.
    await expect(service.record(ben, THEIR_JOB, take({ placeId: THEIR_TRUCK }))).resolves.toBeDefined();
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('is only from a truck this technician may use: never the storeroom, another\'s truck, or one out of use', async () => {
    const { service, write } = harness();
    for (const placeId of [STOCKROOM, THEIR_TRUCK, PARKED_TRUCK, id(998)]) await expect(service.record(ana, JOB, take({ placeId }))).rejects.toMatchObject({ status: 400, code: 'STOCK_PLACE_NOT_YOURS' });
    await expect(service.record(ana, JOB, take({ placeId: SHARED_TRUCK, lines: [{ itemId: BATTERY, quantity: 1 }] }))).resolves.toBeDefined();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('is only for a job of their own, and passes on what the office\'s posting refuses', async () => {
    const { service, write } = harness();
    for (const job of [THEIR_JOB, CANCELLED_JOB]) await expect(service.record(ana, job, take())).rejects.toMatchObject({ status: 404, code: 'ASSIGNED_INSPECTION_NOT_FOUND' });
    await expect(service.record(stranger, JOB, take())).rejects.toMatchObject({ status: 404 });
    expect(write).not.toHaveBeenCalled();

    write.mockRejectedValueOnce(new ApplicationError(409, 'STOCK_SLIP_NOT_READY', 'Only 10 of FLT-0003 are there.'));
    await expect(service.record(ana, JOB, take({ lines: [{ itemId: FILTER, quantity: 11 }] }))).rejects.toMatchObject({ status: 409, message: 'Only 10 of FLT-0003 are there.' });
    // Two phones reached for the same stock: said in the phone's words, not the office page's.
    write.mockRejectedValueOnce(new ApplicationError(409, 'STOCK_NOT_ENOUGH', 'Somebody has just taken some of that stock. Open the tab again to see what is there.'));
    await expect(service.record(ana, JOB, take({ clientRequestId: 'phone-key-0009' }))).rejects.toMatchObject({ code: 'STOCK_NOT_ENOUGH', message: 'Somebody has just taken some of that from the truck. Look again at what is there.' });
    write.mockRejectedValueOnce(new ApplicationError(409, 'STOCK_FROZEN', 'The yearly count CNT-0001 is open, so stock cannot move until it is posted or cancelled.'));
    await expect(service.record(ana, JOB, take({ clientRequestId: 'phone-key-0010' }))).rejects.toMatchObject({ code: 'STOCK_FROZEN' });
  });
});

describe('bringing stock back', () => {
  it('puts back into the truck what was taken for the job, and no more', async () => {
    const { service, posted } = harness();
    await service.record(ana, JOB, take({ lines: [{ itemId: FILTER, quantity: 3 }] }));
    const after = await service.record(ana, JOB, bringBack());

    expect(posted[1]!.input).toMatchObject({ kind: 'RETURN', technicianId: ana.id, fromPlaceId: null, toPlaceId: MY_TRUCK, inspectionId: JOB, lines: [{ itemId: FILTER, quantity: 1 }] });
    expect(after.slips.map((slip) => slip.number)).toEqual(['RT-0002', 'WD-0001']);
    expect(after.taken).toEqual([expect.objectContaining({ itemId: FILTER, quantity: 2 })]);

    await expect(service.record(ana, JOB, bringBack({ clientRequestId: 'phone-key-0003', lines: [{ itemId: FILTER, quantity: 3 }] }))).rejects.toMatchObject({ status: 409, message: 'You took 2 of FLT-0003 for this job, so 3 cannot go back.' });
    // Something never taken for this job: a truck is not filled from the phone.
    await expect(service.record(ana, JOB, bringBack({ clientRequestId: 'phone-key-0004', lines: [{ itemId: BATTERY, quantity: 1 }] }))).rejects.toMatchObject({ status: 409, code: 'STOCK_SLIP_NOT_READY' });
    await expect(service.record(ana, OTHER_JOB, bringBack({ clientRequestId: 'phone-key-0005' }))).rejects.toMatchObject({ status: 409 });
    expect(posted).toHaveLength(2);
  });

  it('does not count what the office has reversed', async () => {
    const { service, slips } = harness();
    await service.record(ana, JOB, take({ lines: [{ itemId: FILTER, quantity: 3 }] }));
    slips[0]!.reversedAt = new Date();
    const stock = await service.forJob(ana, JOB);
    expect(stock.slips[0]).toMatchObject({ reversed: true });
    expect(stock.taken).toEqual([]);
    await expect(service.record(ana, JOB, bringBack())).rejects.toMatchObject({ status: 409 });
  });
});

describe('what the API accepts', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const check = (value: unknown) => pipe.transform(value, { type: 'body', metatype: RecordJobStockDto });

  it('takes what the phone sends', async () => {
    await expect(check(take())).resolves.toMatchObject({ kind: 'WITHDRAWAL', lines: [{ itemId: FILTER, quantity: 2 }] });
    await expect(check(bringBack())).resolves.toMatchObject({ kind: 'RETURN' });
  });

  it('refuses a move, a quantity of nothing, a short key, and any say over whose it is or what it cost', async () => {
    await expect(check(take({ kind: 'TRANSFER' as never }))).rejects.toBeDefined();
    await expect(check(take({ lines: [{ itemId: FILTER, quantity: 0 }] }))).rejects.toBeDefined();
    await expect(check(take({ lines: [] }))).rejects.toBeDefined();
    await expect(check(take({ clientRequestId: 'short' }))).rejects.toBeDefined();
    for (const extra of [{ technicianId: ben.id }, { inspectionId: THEIR_JOB }, { unitCostCents: 1 }, { day: '2026-01-01' }, { fromPlaceId: STOCKROOM }]) await expect(check({ ...take(), ...extra })).rejects.toBeDefined();
  });

  it('is for signed-in technicians, as every phone route is', () => {
    expect(Reflect.getMetadata('roles', TechnicianStockController)).toEqual([UserRole.INSPECTION_TECHNICIAN]);
  });
});

// My truck (the office, 2026-11-24): what is on the technician's trucks, what has run low, and asks for more.
describe('my truck', () => {
  it('lists each truck with what is on it and kept on it -- the run-out ones too -- and the latest slips across jobs', async () => {
    const { service } = harness();
    await service.record(ana, JOB, take());
    const mine = await service.myTrucks(ana);
    expect(mine.trucks.map((truck) => [truck.name, truck.mine, truck.lastCountedOn])).toEqual([
      ['Truck 1', true, '2026-11-02'],
      ['Shared truck', false, null],
    ]);
    expect(mine.trucks[0]!.items.map((item) => [item.code, item.onHand, item.keepAtLeast])).toEqual([
      ['FLT-0003', 8, 12],
      // None on the truck and kept on it: listed, so it is asked for.
      ['PRT-0001', 0, 4],
    ]);
    expect(mine.catalog.map((item) => item.code)).toEqual(['FLT-0003', 'PRT-0001']);
    expect(mine.slips).toEqual([expect.objectContaining({ number: 'WD-0001', kind: 'WITHDRAWAL', place: 'Truck 1', job: { id: JOB, address: '12 Sample Ln' }, lines: [{ code: 'FLT-0003', name: 'Filter 20x25x1', quantity: 2 }] })]);
  });

  it('asks the office for more for their own truck, once however many times it is sent, and moves no stock', async () => {
    const { service, write, asks, askLines, audits } = harness();
    const ask = { placeId: MY_TRUCK, lines: [{ itemId: FILTER, quantity: 4 }, { itemId: BATTERY, quantity: 4 }], note: ' Pick up Wednesday ', clientRequestId: 'phone-ask-0001' };
    const mine = await service.ask(ana, ask);
    await service.ask(ana, ask);
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ placeId: MY_TRUCK, askedById: ana.id, note: 'Pick up Wednesday', requestKey: `phone:${ana.id}:phone-ask-0001` });
    expect(askLines.map((line) => [line.itemId, line.quantity])).toEqual([[FILTER, 4], [BATTERY, 4]]);
    expect(mine.trucks[0]!.asks).toEqual([expect.objectContaining({ status: 'ASKED', note: 'Pick up Wednesday', lines: [expect.objectContaining({ code: 'FLT-0003', quantity: 4 }), expect.objectContaining({ code: 'PRT-0001', quantity: 4 })] })]);
    expect(audits.map((audit) => audit.action)).toEqual(['TRUCK_STOCK_ASKED']);
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses an ask for a truck that is not theirs, with nothing on it, an item twice, or past five waiting', async () => {
    const { service, asks } = harness();
    const ask = (over: Record<string, unknown>) => ({ placeId: MY_TRUCK, lines: [{ itemId: FILTER, quantity: 4 }], note: null, clientRequestId: `phone-ask-${asks.length}${Object.keys(over).join('')}`, ...over });
    await expect(service.ask(ana, ask({ placeId: THEIR_TRUCK }))).rejects.toMatchObject({ code: 'STOCK_PLACE_NOT_YOURS' });
    await expect(service.ask(ana, ask({ placeId: STOCKROOM }))).rejects.toMatchObject({ code: 'STOCK_PLACE_NOT_YOURS' });
    await expect(service.ask(ana, ask({ lines: [{ itemId: FILTER, quantity: 0 }] }))).rejects.toMatchObject({ code: 'TRUCK_ASK_NOT_READY' });
    await expect(service.ask(ana, ask({ lines: [{ itemId: FILTER, quantity: 1 }, { itemId: FILTER, quantity: 2 }] }))).rejects.toMatchObject({ code: 'TRUCK_ASK_ITEM_TWICE' });
    for (let n = 0; n < 5; n += 1) await service.ask(ana, { ...ask({}), clientRequestId: `phone-ask-more-${n}` });
    await expect(service.ask(ana, { ...ask({}), clientRequestId: 'phone-ask-sixth' })).rejects.toMatchObject({ code: 'TRUCK_ASKS_WAITING', message: 'Truck 1 has 5 asks waiting already. The office fills those first.' });
  });

  it('takes the ask the phone sends and nothing else', async () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const check = (body: unknown) => pipe.transform(body, { type: 'body', metatype: AskForTruckStockDto });
    const ask = { placeId: MY_TRUCK, lines: [{ itemId: FILTER, quantity: 4 }], note: null, clientRequestId: 'phone-ask-0001' };
    await expect(check(ask)).resolves.toMatchObject({ placeId: MY_TRUCK });
    for (const extra of [{ askedById: ben.id }, { status: 'FILLED' }]) await expect(check({ ...ask, ...extra })).rejects.toBeTruthy();
    await expect(check({ ...ask, lines: [] })).rejects.toBeTruthy();
  });
});
