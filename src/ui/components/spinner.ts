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

// Spinner — animated indicator for long-running async operations

import { cyan, green, red } from '../colors.js';
import { isMockActive, recordCall } from '../mock.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const INTERVAL_MS = 80;

/**
 * Run task with animated spinner. Shows ✓ on success, ✗ on failure.
 * Falls back to plain print in non-TTY or mock mode.
 */
export async function withSpinner<T>(message: string, task: () => Promise<T>): Promise<T> {
  if (isMockActive()) {
    recordCall('spinner', message);
    return await task();
  }

  if (!process.stdout.isTTY) {
    process.stdout.write(`${message}...\n`);
    return await task();
  }

  let frame = 0;
  const interval = setInterval(() => {
    process.stdout.write(`\r  ${cyan(FRAMES[frame])}  ${message}`);
    frame = (frame + 1) % FRAMES.length;
  }, INTERVAL_MS);

  try {
    const result = await task();
    clearInterval(interval);
    process.stdout.write(`\r  ${green('✓')}  ${message}\n`);
    return result;
  } catch (err) {
    clearInterval(interval);
    process.stdout.write(`\r  ${red('✗')}  ${message}\n`);
    throw err;
  }
}
