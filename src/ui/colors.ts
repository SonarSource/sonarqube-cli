// Color palette and TTY detection

import pc from 'picocolors';
import type { ColorFn, StepStatus } from './types.js';

// When stdout is not a TTY (piped), all color functions become identity
export const isTTY = process.stdout.isTTY;

function c(fn: (s: string) => string): ColorFn {
  return (s: string) => (isTTY ? fn(s) : s);
}

export const green  = c(pc.green);
export const red    = c(pc.red);
export const yellow = c(pc.yellow);
export const cyan   = c(pc.cyan);
export const gray   = c(pc.gray);
export const bold   = c(pc.bold);
export const dim    = c(pc.dim);
export const white  = c(pc.white);

export const STATUS_COLORS: Record<StepStatus, ColorFn> = {
  done:    green,
  running: cyan,
  failed:  red,
  skipped: dim,
  warn:    yellow,
  pending: dim,
  info:    cyan,
};

export const STATUS_ICONS: Record<StepStatus, string> = {
  done:    '✓',
  running: '→',
  failed:  '✗',
  skipped: '⏭',
  warn:    '⚠',
  pending: '○',
  info:    'ℹ',
};
