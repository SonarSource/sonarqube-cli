import { existsSync, readFileSync } from 'node:fs';

export function readJson<T>(path: string): T | null {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : null;
}

export function lastSegment(value: string): string {
  return value.slice(value.lastIndexOf('/') + 1);
}
