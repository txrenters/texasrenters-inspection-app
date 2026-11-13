import { SEND_SOON_MS, SEND_SOON_RETRY_MS, XeroSenderService } from '../src/integrations/xero/xero-sender.service';

/**
 * An invoice made here goes to its company's books in Xero at once
 * (2026-11-13): the office was told "Draft made in Xero" at the save and looked
 * there before the next ten-minute run had sent it. Everything invented.
 */

const ORG = '00000000-0000-4000-8000-000000000001';
const HOMES = '11111111-1111-4111-8111-111111111111';
const PEST = '22222222-2222-4222-8222-222222222222';
const BUSY = 'Another run is sending to Xero, or reading from it.';

function sender() {
  const service = new XeroSenderService({} as never, {} as never, {} as never, {} as never, {} as never);
  const run = jest.spyOn(service, 'run').mockResolvedValue({ problem: null } as never);
  return { service, run };
}

const settle = async () => {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
};

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.useRealTimers();
  delete process.env.XERO_SENDING_ENABLED;
});

describe('sending what was just made', () => {
  it('runs each company once, a moment after the save, for everything saved meanwhile', async () => {
    const { service, run } = sender();
    service.sendSoon(ORG, [HOMES, null]);
    service.sendSoon(ORG, [HOMES, PEST, HOMES]);
    expect(run).not.toHaveBeenCalled();

    jest.advanceTimersByTime(SEND_SOON_MS);
    await settle();
    expect(run.mock.calls).toEqual([
      [ORG, HOMES],
      [ORG, PEST],
    ]);

    // A save after the run started gets a run of its own.
    service.sendSoon(ORG, [HOMES]);
    jest.advanceTimersByTime(SEND_SOON_MS);
    await settle();
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('tries once more when another run holds the company, then leaves it to the scheduled run', async () => {
    const { service, run } = sender();
    run.mockResolvedValue({ problem: BUSY } as never);
    service.sendSoon(ORG, [HOMES]);
    jest.advanceTimersByTime(SEND_SOON_MS);
    await settle();
    expect(run).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(SEND_SOON_RETRY_MS);
    await settle();
    expect(run).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(SEND_SOON_RETRY_MS * 10);
    await settle();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('never throws at the save: a run that fails is logged', async () => {
    const { service, run } = sender();
    run.mockRejectedValue(new Error('database gone'));
    service.sendSoon(ORG, [HOMES]);
    jest.advanceTimersByTime(SEND_SOON_MS);
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('sends nothing on a server with sending switched off, or once shut down', async () => {
    process.env.XERO_SENDING_ENABLED = 'false';
    const off = sender();
    off.service.sendSoon(ORG, [HOMES]);
    jest.advanceTimersByTime(SEND_SOON_MS);
    await settle();
    expect(off.run).not.toHaveBeenCalled();

    delete process.env.XERO_SENDING_ENABLED;
    const closing = sender();
    closing.service.sendSoon(ORG, [HOMES]);
    closing.service.onModuleDestroy();
    jest.advanceTimersByTime(SEND_SOON_MS);
    await settle();
    expect(closing.run).not.toHaveBeenCalled();
  });
});
