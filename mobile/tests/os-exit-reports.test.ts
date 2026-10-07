import { clearErrorLog, readErrorLog } from '../src/lib/error-log';
import {
  collectOsExitReports,
  startOsExitReports,
  summarizeExitReports,
  type RawExitReport,
} from '../src/lib/os-exit-reports';

/**
 * Why the operating system closed the app (2026-10-07).
 *
 * iPhones froze and then closed during move-outs, and the error log had
 * nothing: running out of memory, or the watchdog ending an app that stopped
 * answering, kills the process before any JavaScript runs. iOS and Android
 * both record why, and the app now reads it on its next launch.
 */

const RECEIVED = '2026-10-07T15:00:00Z';

const metrics = (foreground: Record<string, number>, background: Record<string, number> = {}): RawExitReport => ({
  kind: 'metrics',
  receivedAt: RECEIVED,
  json: JSON.stringify({
    timeStampBegin: '2026-10-06 00:00:00 +0000',
    timeStampEnd: '2026-10-06 23:59:00 +0000',
    applicationExitMetrics: {
      foregroundExitData: { cumulativeNormalAppExitCount: 3, ...foreground },
      backgroundExitData: { cumulativeMemoryPressureExitCount: 4, ...background },
    },
    memoryMetrics: { peakMemoryUsage: '1450000 kB' },
    metaData: { deviceType: 'iPhone14,5', osVersion: 'iPhone OS 18.6', lowPowerModeEnabled: true },
  }),
});

const frame = (binaryName: string, offset: number, subFrames: unknown[] = []) => ({
  binaryName,
  offsetIntoBinaryTextSegment: offset,
  subFrames,
});

const diagnostics = (payload: Record<string, unknown>): RawExitReport => ({
  kind: 'diagnostics',
  receivedAt: RECEIVED,
  json: JSON.stringify({ timeStampBegin: '2026-10-07 14:00:00 +0000', ...payload }),
});

const androidExit = (detail: Record<string, unknown>): RawExitReport => ({
  kind: 'android-exit',
  receivedAt: '1791385200000',
  json: JSON.stringify({ description: '', status: 0, pssKb: 0, rssKb: 0, ...detail }),
});

describe("iOS's daily count of how the app was closed", () => {
  it('names each cause, and counts one on screen as a crash the technician saw', () => {
    const [entry] = summarizeExitReports([
      metrics({ cumulativeMemoryResourceLimitExitCount: 2, cumulativeAppWatchdogExitCount: 1 }),
    ]);
    expect(entry).toMatchObject({
      fatal: true,
      at: '2026-10-07T15:00:00.000Z',
      message:
        'iOS closed the app (daily report) — on screen: 2 × over the memory limit, 1 × stopped responding (watchdog)',
    });
    expect(JSON.parse(entry!.detail)).toMatchObject({
      peakMemory: '1450000 kB',
      device: { lowPowerModeEnabled: true },
    });
  });

  it('says nothing about a day of normal exits and memory reclaimed in the background', () => {
    expect(summarizeExitReports([metrics({})])).toEqual([]);
  });

  it('notes a background cause without calling it a crash', () => {
    const [entry] = summarizeExitReports([metrics({}, { cumulativeBackgroundTaskAssertionTimeoutExitCount: 1 })]);
    expect(entry).toMatchObject({ fatal: false });
    expect(entry?.message).toMatch(/in the background: 1 × ran out of background time/);
  });
});

describe('iOS diagnostics from the last session', () => {
  it('calls a watchdog kill what it is, with the frames iOS blamed', () => {
    const [entry] = summarizeExitReports([
      diagnostics({
        crashDiagnostics: [
          {
            diagnosticMetaData: {
              exceptionType: 10,
              signal: 9,
              terminationReason: 'Namespace FRONTBOARD, Code 0x8badf00d',
            },
            callStackTree: {
              callStacks: [
                { threadAttributed: false, callStackRootFrames: [frame('libsystem_kernel.dylib', 1)] },
                {
                  threadAttributed: true,
                  callStackRootFrames: [frame('hermes', 4242, [frame('TexasRentersInspect', 77)])],
                },
              ],
            },
          },
        ],
      }),
    ]);
    expect(entry).toMatchObject({
      fatal: true,
      message: 'iOS ended the app because it stopped responding (watchdog)',
    });
    expect(JSON.parse(entry!.detail).stack).toEqual(['hermes +4242', 'TexasRentersInspect +77']);
  });

  it('names the exception and signal of an ordinary crash', () => {
    const [entry] = summarizeExitReports([
      diagnostics({ crashDiagnostics: [{ diagnosticMetaData: { exceptionType: 1, signal: 11 } }] }),
    ]);
    expect(entry?.message).toBe('iOS: the app crashed (EXC_BAD_ACCESS / SIGSEGV)');
  });

  it('logs a hang and a CPU excess as warnings, one line each', () => {
    const entries = summarizeExitReports([
      diagnostics({
        hangDiagnostics: [{ diagnosticMetaData: { hangDuration: '4.2 sec' } }],
        cpuExceptionDiagnostics: [{ diagnosticMetaData: { totalCPUTime: '90 sec', totalSampledTime: '180 sec' } }],
      }),
    ]);
    expect(entries.map((entry) => [entry.message, entry.fatal])).toEqual([
      ['iOS: the app stopped responding for 4.2 sec', false],
      ['iOS: the app used too much CPU (90 sec in 180 sec)', false],
    ]);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(2);
  });
});

describe("Android's exit reasons", () => {
  it('reports a crash and an ANR', () => {
    const entries = summarizeExitReports([
      androidExit({ reason: 'CRASH', importance: 100, description: 'crash' }),
      androidExit({ reason: 'ANR', importance: 100 }),
    ]);
    expect(entries.map((entry) => [entry.message, entry.fatal])).toEqual([
      ['Android: the app crashed — crash', true],
      ['Android: the app stopped responding (ANR)', true],
    ]);
    expect(entries[0]?.at).toBe(new Date(1_791_385_200_000).toISOString());
  });

  it('reports memory kills only while the app was in use, or running the shift', () => {
    const entries = summarizeExitReports([
      androidExit({ reason: 'LOW_MEMORY', importance: 125 }), // the location service
      androidExit({ reason: 'LOW_MEMORY', importance: 400 }), // cached, out of sight
    ]);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.message).toBe('Android closed the app to free memory while it was in use');
  });

  it('leaves out the exits that are nobody’s fault', () => {
    expect(
      summarizeExitReports([
        androidExit({ reason: 'USER_REQUESTED', importance: 100 }),
        androidExit({ reason: 'EXIT_SELF', importance: 400 }),
        androidExit({ reason: 'PACKAGE_UPDATED', importance: 400 }),
      ]),
    ).toEqual([]);
  });
});

describe('collecting on launch', () => {
  beforeEach(() => clearErrorLog());

  it('puts each report in the error log once, however many times it is handed over', async () => {
    const report = metrics({ cumulativeMemoryResourceLimitExitCount: 1 });
    const native = { takeReports: jest.fn(async () => JSON.stringify([report])) };

    await collectOsExitReports(native);
    await collectOsExitReports(native);

    const log = await readErrorLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ source: 'os-exit', fatal: true });
    expect(log[0]?.stack).toContain('1450000 kB');
  });

  it('never fails because a report could not be read', async () => {
    await expect(collectOsExitReports({ takeReports: async () => 'not json' })).resolves.toBe(0);
    await expect(
      collectOsExitReports({
        takeReports: async () => {
          throw new Error('module gone');
        },
      }),
    ).resolves.toBe(0);
  });

  it('does nothing at all on a binary built before the module', () => {
    expect(() => startOsExitReports(null)()).not.toThrow();
  });
});
