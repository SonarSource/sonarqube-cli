/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

// Inline terminal output — non-interactive, static messages

import { isTTY, cyan, yellow, red, green } from './colors.js';
import { isMockActive, recordCall } from './mock.js';
import type { ColorFn } from './types.js';

function write(stream: NodeJS.WriteStream, line: string): void {
  stream.write(line + '\n');
}

export function info(message: string): void {
  if (isMockActive()) {
    recordCall('info', message);
    return;
  }
  write(process.stdout, `  ${cyan('ℹ')}  ${message}`);
}

export function success(message: string): void {
  if (isMockActive()) {
    recordCall('success', message);
    return;
  }
  write(process.stdout, `  ${green('✓')}  ${message}`);
}

export function warn(message: string): void {
  if (isMockActive()) {
    recordCall('warn', message);
    return;
  }
  write(process.stderr, `  ${yellow('⚠')}  ${message}`);
}

export function error(message: string): void {
  if (isMockActive()) {
    recordCall('error', message);
    return;
  }
  write(process.stderr, `  ${red('✗')}  ${message}`);
}

// Plain terminal output — human-readable, no semantic icon, optional color
export function text(message: string, color?: ColorFn): void {
  if (isMockActive()) {
    recordCall('text', message);
    return;
  }
  const formatted = color ? color(message) : message;
  write(process.stdout, formatted);
}

// Raw stdout — no color, no prefix — safe for piping: sonar issues search | jq
export function print(message: string): void {
  if (isMockActive()) {
    recordCall('print', message);
    return;
  }
  process.stdout.write(message + (message.endsWith('\n') ? '' : '\n'));
}

// Newline separator
export function blank(): void {
  if (isMockActive()) {
    recordCall('blank');
    return;
  }
  if (isTTY) process.stdout.write('\n');
}
