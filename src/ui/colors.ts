/*
 * SonarQube CLI
 * Copyright (C) SonarSource Sàrl
 * mailto:info AT sonarsource DOT com
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 3 of the License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program; if not, write to the Free Software Foundation,
 * Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.
 */

// Color palette and TTY detection

import pc from 'picocolors';

import type { ColorFn, StepStatus } from './types.js';

// When stdout is not a TTY (piped), all color functions become identity
export const isTTY = process.stdout.isTTY;

function c(fn: (s: string) => string): ColorFn {
  return (s: string) => (isTTY ? fn(s) : s);
}

const SOFT_BLUE = 153; // #8FCAEA

function ansi256(n: number): ColorFn {
  return (s: string) => (isTTY ? `\x1b[38;5;${n}m${s}\x1b[0m` : s);
}

export const green = c(pc.green);
export const red = c(pc.red);
export const yellow = c(pc.yellow);
export const cyan = c(pc.cyan);
export const gray = c(pc.gray);
export const bold = c(pc.bold);
export const dim = c(pc.dim);
export const underline = c(pc.underline);
export const white = c(pc.white);
export const blue = c(pc.blue);
export const softBlue = ansi256(SOFT_BLUE);

export const STATUS_COLORS: Record<StepStatus, ColorFn> = {
  done: green,
  running: cyan,
  failed: red,
  skipped: dim,
  warn: yellow,
  pending: dim,
  info: cyan,
};

export const STATUS_ICONS: Record<StepStatus, string> = {
  done: '✓',
  running: '→',
  failed: '✗',
  skipped: '⏭',
  warn: '⚠',
  pending: '○',
  info: 'ℹ',
};
