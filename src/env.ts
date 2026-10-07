import { readFileSync } from 'node:fs';
import { TranslateError } from './errors.js';

export function loadDotEnv(filePath: string): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return {};
    throw err;
  }

  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const body = trimmed.startsWith('export ') ? trimmed.slice(7) : trimmed;
    const eq = body.indexOf('=');
    if (eq === -1) continue;
    const key = body.slice(0, eq).trim();
    let value = body.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

export function interpolate(input: string, env: Record<string, string>): string {
  let out = '';
  for (let i = 0; i < input.length; i++) {
    if (input[i] === '$' && input[i + 1] === '$') {
      out += '$';
      i++;
      continue;
    }
    if (input[i] !== '$') {
      out += input[i];
      continue;
    }
    if (input[i + 1] === '{') {
      const end = input.indexOf('}', i + 2);
      if (end === -1) {
        out += '$';
        continue;
      }
      out += expandBraces(input.slice(i + 2, end), env);
      i = end;
      continue;
    }
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(input.slice(i + 1));
    if (!match) {
      out += '$';
      continue;
    }
    out += env[match[0]] ?? '';
    i += match[0].length;
  }
  return out;
}

function expandBraces(body: string, env: Record<string, string>): string {
  const nameMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(body);
  if (!nameMatch) return '';
  const name = nameMatch[0];
  const rest = body.slice(name.length);
  const value = env[name];
  const unset = value === undefined;
  const empty = unset || value === '';

  if (rest === '') return value ?? '';
  if (rest.startsWith(':-')) return empty ? rest.slice(2) : (value ?? '');
  if (rest.startsWith('-')) return unset ? rest.slice(1) : (value ?? '');
  if (rest.startsWith(':?')) {
    if (empty) throw new TranslateError(rest.slice(2) || `${name} is required`);
    return value ?? '';
  }
  if (rest.startsWith('?')) {
    if (unset) throw new TranslateError(rest.slice(1) || `${name} is required`);
    return value ?? '';
  }
  return value ?? '';
}

export function interpolateTree(value: unknown, env: Record<string, string>): unknown {
  if (typeof value === 'string') return interpolate(value, env);
  if (Array.isArray(value)) return value.map((item) => interpolateTree(item, env));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[interpolate(key, env)] = interpolateTree(item, env);
    }
    return out;
  }
  return value;
}
