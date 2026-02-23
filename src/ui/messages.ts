// Inline terminal output — non-interactive, static messages

import { isTTY, cyan, yellow, red, green } from './colors.js';
import { isMockActive, recordCall } from './mock.js';
import type { ColorFn } from './types.js';

function write(stream: NodeJS.WriteStream, line: string): void {
  stream.write(line + '\n');
}

export function info(message: string): void {
  if (isMockActive()) { recordCall('info', message); return; }
  write(process.stdout, `  ${cyan('ℹ')}  ${message}`);
}

export function success(message: string): void {
  if (isMockActive()) { recordCall('success', message); return; }
  write(process.stdout, `  ${green('✓')}  ${message}`);
}

export function warn(message: string): void {
  if (isMockActive()) { recordCall('warn', message); return; }
  write(process.stderr, `  ${yellow('⚠')}  ${message}`);
}

export function error(message: string): void {
  if (isMockActive()) { recordCall('error', message); return; }
  write(process.stderr, `  ${red('✗')}  ${message}`);
}

// Plain terminal output — human-readable, no semantic icon, optional color
export function text(message: string, color?: ColorFn): void {
  if (isMockActive()) { recordCall('text', message); return; }
  const formatted = color ? color(message) : message;
  write(process.stdout, formatted);
}

// Raw stdout — no color, no prefix — safe for piping: sonar issues search | jq
export function print(message: string): void {
  if (isMockActive()) { recordCall('print', message); return; }
  process.stdout.write(message + (message.endsWith('\n') ? '' : '\n'));
}

// Newline separator
export function blank(): void {
  if (isMockActive()) { recordCall('blank'); return; }
  if (isTTY) process.stdout.write('\n');
}
