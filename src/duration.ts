const UNITS: Record<string, number> = {
  ns: 1 / 1_000_000,
  us: 1 / 1_000,
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

export function parseDurationMs(value: string | number | undefined, fallbackMs: number): number {
  if (value === undefined) return fallbackMs;
  if (typeof value === 'number') return value;
  const match = /^(\d+(?:\.\d+)?)(ns|us|ms|s|m|h)?$/.exec(value.trim());
  if (!match) return fallbackMs;
  const amount = Number(match[1]);
  const unit = match[2] ?? 's';
  return Math.round(amount * UNITS[unit]);
}

export function parseGraceSeconds(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return Math.max(1, Math.round(parseDurationMs(value, 10_000) / 1_000));
}
