import { requireOptionalNativeModule } from 'expo';
import { AppState } from 'react-native';

import { recordOsReports } from './error-log';

/**
 * Why the operating system closed the app, into the error log.
 *
 * Technicians on move-outs saw the app freeze and then close to the home
 * screen (2026-10-06), and the error log had nothing: running out of memory,
 * or being ended by the watchdog for not answering, kills the process before
 * any JavaScript handler can run. The session breadcrumb can tell that a
 * session ended badly, but not why. iOS and Android both record why, and the
 * `ExitReasons` module (`modules/exit-reasons`) reads it on the next launch.
 *
 * The module is only in binaries built after it was added (2026-10-07; see
 * `version` in app.config.ts). It is loaded as optional, so the same
 * JavaScript on an older 1.3.0 binary reports nothing rather than failing.
 */

interface ExitReasonsNative {
  /** A JSON array of `RawExitReport`, forgotten natively once returned. */
  takeReports(): Promise<string>;
}

export interface RawExitReport {
  kind: 'metrics' | 'diagnostics' | 'android-exit' | string;
  /** The platform's own report, as JSON. */
  json: string;
  /** ISO 8601 on iOS; milliseconds since the epoch on Android. */
  receivedAt: string;
}

export interface ExitReportEntry {
  id: string;
  at: string;
  message: string;
  detail: string;
  fatal: boolean;
}

/** Collects at launch and whenever the app comes back; a no-op where the binary has no module. */
export function startOsExitReports(
  native: ExitReasonsNative | null = requireOptionalNativeModule<ExitReasonsNative>('ExitReasons'),
): () => void {
  if (!native) return () => undefined;
  void collectOsExitReports(native);
  // iOS hands over what it held back shortly after the app subscribes, which
  // can be after this first look -- so look again each time the app returns.
  const subscription = AppState.addEventListener('change', (state) => {
    if (state === 'active') void collectOsExitReports(native);
  });
  return () => subscription.remove();
}

export async function collectOsExitReports(native: ExitReasonsNative): Promise<number> {
  try {
    const parsed: unknown = JSON.parse(await native.takeReports());
    const entries = summarizeExitReports(Array.isArray(parsed) ? (parsed as RawExitReport[]) : []);
    await recordOsReports(entries);
    return entries.length;
  } catch {
    // A report about a failure must never become one.
    return 0;
  }
}

/** One error-log line per thing worth knowing; normal exits are left out. */
export function summarizeExitReports(reports: RawExitReport[]): ExitReportEntry[] {
  const entries: ExitReportEntry[] = [];
  for (const report of reports) {
    let payload: unknown;
    try {
      payload = JSON.parse(report.json);
    } catch {
      continue;
    }
    if (!isObject(payload)) continue;
    const at = timeOf(report.receivedAt);
    const id = (suffix: string) => `os-${report.kind}-${hash(report.json)}${suffix}`;
    if (report.kind === 'metrics') {
      const entry = exitCounts(payload);
      if (entry) entries.push({ id: id(''), at, ...entry });
    } else if (report.kind === 'diagnostics') {
      diagnostics(payload).forEach((entry, index) => entries.push({ id: id(`-${index}`), at, ...entry }));
    } else if (report.kind === 'android-exit') {
      const entry = androidExit(payload);
      if (entry) entries.push({ id: id(''), at, ...entry });
    }
  }
  return entries;
}

type Summary = Omit<ExitReportEntry, 'id' | 'at'>;

/**
 * iOS's count of exits that are the app's own doing. Left out: a normal exit,
 * and memory pressure -- iOS reclaiming a suspended app, which every app sees.
 */
const IOS_EXIT_CAUSES: Record<string, string> = {
  cumulativeMemoryResourceLimitExitCount: 'over the memory limit',
  cumulativeAppWatchdogExitCount: 'stopped responding (watchdog)',
  cumulativeCPUResourceLimitExitCount: 'too much CPU',
  cumulativeBadAccessExitCount: 'crashed (bad memory access)',
  cumulativeIllegalInstructionExitCount: 'crashed (illegal instruction)',
  cumulativeAbnormalExitCount: 'crashed',
  cumulativeSuspendedWithLockedFileExitCount: 'suspended holding a locked file',
  cumulativeBackgroundTaskAssertionTimeoutExitCount: 'ran out of background time',
  cumulativeBackgroundURLSessionCompletionTimeoutExitCount: 'ran out of time after a background upload',
  cumulativeBackgroundFetchCompletionTimeoutExitCount: 'ran out of background fetch time',
};

function exitCounts(payload: Record<string, unknown>): Summary | null {
  const exits = objectAt(payload, 'applicationExitMetrics');
  const foreground = counted(objectAt(exits, 'foregroundExitData'));
  const background = counted(objectAt(exits, 'backgroundExitData'));
  if (!foreground.length && !background.length) return null;
  const list = (causes: [string, number][]) => causes.map(([cause, count]) => `${count} × ${cause}`).join(', ');
  const parts = [
    foreground.length ? `on screen: ${list(foreground)}` : null,
    background.length ? `in the background: ${list(background)}` : null,
  ].filter(Boolean);
  const memory = objectAt(payload, 'memoryMetrics');
  const cpu = objectAt(payload, 'cpuMetrics');
  return {
    message: `iOS closed the app (daily report) — ${parts.join('; ')}`,
    detail: JSON.stringify({
      from: payload.timeStampBegin,
      to: payload.timeStampEnd,
      foreground: Object.fromEntries(foreground),
      background: Object.fromEntries(background),
      peakMemory: memory?.peakMemoryUsage,
      cpuTime: cpu?.cumulativeCPUTime,
      hangs: objectAt(payload, 'applicationResponsivenessMetrics')?.histogrammedAppHangTime,
      device: payload.metaData,
    }),
    // On screen is where a technician lost what they were doing.
    fatal: foreground.length > 0,
  };
}

function counted(data: Record<string, unknown> | undefined): [string, number][] {
  if (!data) return [];
  return Object.entries(IOS_EXIT_CAUSES)
    .map(([key, cause]): [string, number] => [cause, Number(data[key] ?? 0)])
    .filter(([, count]) => Number.isFinite(count) && count > 0);
}

const EXCEPTION_TYPES: Record<number, string> = {
  1: 'EXC_BAD_ACCESS',
  2: 'EXC_BAD_INSTRUCTION',
  3: 'EXC_ARITHMETIC',
  5: 'EXC_SOFTWARE',
  6: 'EXC_BREAKPOINT',
  10: 'EXC_CRASH',
  11: 'EXC_RESOURCE',
  12: 'EXC_GUARD',
};
const SIGNALS: Record<number, string> = { 4: 'SIGILL', 5: 'SIGTRAP', 6: 'SIGABRT', 9: 'SIGKILL', 10: 'SIGBUS', 11: 'SIGSEGV' };

function diagnostics(payload: Record<string, unknown>): Summary[] {
  const of = (key: string) => (Array.isArray(payload[key]) ? (payload[key] as unknown[]).filter(isObject) : []);
  const detail = (diagnostic: Record<string, unknown>) =>
    JSON.stringify({ ...objectAt(diagnostic, 'diagnosticMetaData'), stack: stackOf(diagnostic) });

  return [
    ...of('crashDiagnostics').map((diagnostic): Summary => {
      const meta = objectAt(diagnostic, 'diagnosticMetaData') ?? {};
      const reason = typeof meta.terminationReason === 'string' ? meta.terminationReason : '';
      const kind = [EXCEPTION_TYPES[Number(meta.exceptionType)], SIGNALS[Number(meta.signal)]].filter(Boolean).join(' / ');
      return {
        message: /8badf00d/i.test(reason)
          ? 'iOS ended the app because it stopped responding (watchdog)'
          : `iOS: the app crashed${kind ? ` (${kind})` : ''}${reason ? ` — ${reason}` : ''}`,
        detail: detail(diagnostic),
        fatal: true,
      };
    }),
    ...of('hangDiagnostics').map((diagnostic): Summary => ({
      message: `iOS: the app stopped responding for ${String(objectAt(diagnostic, 'diagnosticMetaData')?.hangDuration ?? 'a while')}`,
      detail: detail(diagnostic),
      fatal: false,
    })),
    ...of('cpuExceptionDiagnostics').map((diagnostic): Summary => {
      const meta = objectAt(diagnostic, 'diagnosticMetaData') ?? {};
      return {
        message: `iOS: the app used too much CPU (${String(meta.totalCPUTime ?? '?')} in ${String(meta.totalSampledTime ?? '?')})`,
        detail: detail(diagnostic),
        fatal: false,
      };
    }),
    ...of('diskWriteExceptionDiagnostics').map((diagnostic): Summary => ({
      message: `iOS: the app wrote too much to disk (${String(objectAt(diagnostic, 'diagnosticMetaData')?.writesCaused ?? '?')})`,
      detail: detail(diagnostic),
      fatal: false,
    })),
    ...of('appLaunchDiagnostics').map((diagnostic): Summary => ({
      message: `iOS: the app was slow to open (${String(objectAt(diagnostic, 'diagnosticMetaData')?.launchDuration ?? '?')})`,
      detail: detail(diagnostic),
      fatal: false,
    })),
  ];
}

/**
 * The innermost frames of the stack iOS blamed, as "binary +offset".
 * Unsymbolicated, but the binary alone says whether it died in Hermes, the
 * camera, or the app's own code.
 */
function stackOf(diagnostic: Record<string, unknown>, limit = 40): string[] {
  const tree = objectAt(diagnostic, 'callStackTree');
  const stacks = Array.isArray(tree?.callStacks) ? (tree.callStacks as unknown[]).filter(isObject) : [];
  const stack = stacks.find((candidate) => candidate.threadAttributed === true) ?? stacks[0];
  const frames: string[] = [];
  let frame = Array.isArray(stack?.callStackRootFrames) ? (stack.callStackRootFrames as unknown[])[0] : undefined;
  while (isObject(frame) && frames.length < limit) {
    frames.push(`${String(frame.binaryName ?? '?')} +${String(frame.offsetIntoBinaryTextSegment ?? '?')}`);
    frame = Array.isArray(frame.subFrames) ? (frame.subFrames as unknown[])[0] : undefined;
  }
  return frames;
}

/** Android's reasons that are nobody's fault: the app, the user or an update ended it. */
const ANDROID_ROUTINE = new Set([
  'EXIT_SELF',
  'USER_REQUESTED',
  'USER_STOPPED',
  'PACKAGE_UPDATED',
  'PACKAGE_STATE_CHANGE',
  'PERMISSION_CHANGE',
  'UNKNOWN',
]);
/** Ended only for the room it took up, unless it was on screen or running the shift's service. */
const ANDROID_RECLAIMED = new Set(['LOW_MEMORY', 'SIGNALED', 'FREEZER', 'OTHER']);
/** `ActivityManager.RunningAppProcessInfo.IMPORTANCE_PERCEPTIBLE`: anything above is out of sight. */
const IMPORTANCE_PERCEPTIBLE = 230;

const ANDROID_MESSAGES: Record<string, string> = {
  CRASH: 'Android: the app crashed',
  CRASH_NATIVE: 'Android: the app crashed in native code',
  ANR: 'Android: the app stopped responding (ANR)',
  LOW_MEMORY: 'Android closed the app to free memory while it was in use',
  EXCESSIVE_RESOURCE_USAGE: 'Android closed the app for using too much CPU or memory',
  INITIALIZATION_FAILURE: 'Android: the app failed to start',
};
const ANDROID_FATAL = new Set(['CRASH', 'CRASH_NATIVE', 'ANR', 'LOW_MEMORY', 'EXCESSIVE_RESOURCE_USAGE', 'INITIALIZATION_FAILURE']);

function androidExit(payload: Record<string, unknown>): Summary | null {
  const reason = typeof payload.reason === 'string' ? payload.reason : 'UNKNOWN';
  if (ANDROID_ROUTINE.has(reason)) return null;
  const importance = Number(payload.importance);
  if (ANDROID_RECLAIMED.has(reason) && !(importance <= IMPORTANCE_PERCEPTIBLE)) return null;
  const description = typeof payload.description === 'string' && payload.description ? ` — ${payload.description}` : '';
  return {
    message: `${ANDROID_MESSAGES[reason] ?? `Android ended the app (${reason})`}${description}`,
    detail: JSON.stringify(payload),
    fatal: ANDROID_FATAL.has(reason),
  };
}

function timeOf(receivedAt: string) {
  const millis = /^\d+$/.test(receivedAt) ? Number(receivedAt) : Date.parse(receivedAt);
  return new Date(Number.isFinite(millis) ? millis : Date.now()).toISOString();
}

/** A short, stable id for a report, so one handed over twice is logged once. */
function hash(text: string) {
  let value = 5381;
  for (let index = 0; index < text.length; index += 1) value = ((value * 33) ^ text.charCodeAt(index)) >>> 0;
  return value.toString(36);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function objectAt(value: Record<string, unknown> | undefined, key: string) {
  const found = value?.[key];
  return isObject(found) ? found : undefined;
}
