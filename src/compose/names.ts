import { basename, dirname, isAbsolute, resolve } from 'node:path';

const INVALID = /[^a-z0-9_.-]+/gi;

export function sanitizeName(name: string): string {
  const cleaned = name.trim().replace(INVALID, '-').replace(/^[^a-z0-9]+/i, '');
  return cleaned || 'compose';
}

export function defaultProjectName(filePaths: string[]): string {
  if (filePaths.length === 1) {
    const base = basename(filePaths[0]).replace(/\.(ya?ml)$/i, '');
    const slug = base.replace(/^docker-compose[.-]/i, '').replace(/^compose[.-]/i, '');
    if (slug && slug !== 'compose' && slug !== 'docker-compose') return sanitizeName(slug);
  }
  return sanitizeName(basename(dirname(resolve(filePaths[0]))));
}

export function splitCommand(input: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        out.push(current);
        current = '';
      }
      continue;
    }
    if (ch === '\\' && i + 1 < input.length) {
      current += input[++i];
      continue;
    }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

export function resolveHostPath(source: string, composeDir: string): string {
  if (isAbsolute(source)) return source;
  return resolve(composeDir, source);
}

export function isBindSource(source: string): boolean {
  return source.startsWith('/') || source.startsWith('.') || source.startsWith('~');
}
