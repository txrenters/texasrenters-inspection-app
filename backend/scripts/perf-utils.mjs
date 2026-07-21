import { performance } from 'node:perf_hooks';

export function percentile(values, value) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(value * sorted.length) - 1)];
}

export function summarize(samples) {
  const warm = samples.slice(1);
  const measured = warm.length ? warm : samples;
  return {
    samples: samples.length,
    coldMs: round(samples[0] ?? 0),
    warmMedianMs: round(percentile(measured, 0.5)),
    warmP95Ms: round(percentile(measured, 0.95)),
    warmP99Ms: round(percentile(measured, 0.99)),
  };
}

export async function measure(operation, samples = 12) {
  const durations = [];
  let value;
  for (let index = 0; index < samples; index += 1) {
    const startedAt = performance.now();
    value = await operation();
    durations.push(performance.now() - startedAt);
  }
  return { value, durations, summary: summarize(durations) };
}

export function round(value) {
  return Math.round(value * 10) / 10;
}
