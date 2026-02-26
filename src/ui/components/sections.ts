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

// Structural markers — intro, outro

import { isTTY, bold, green, red } from '../colors.js';
import { isMockActive, recordCall } from '../mock.js';

const DIVIDER_BASE_WIDTH = 40;
const DIVIDER_WIDTH = DIVIDER_BASE_WIDTH + 2; // + 2 for indent alignment
const DIVIDER = '━'.repeat(DIVIDER_WIDTH);

export function intro(title: string, subtitle?: string): void {
  if (isMockActive()) {
    recordCall('intro', title, subtitle);
    return;
  }

  if (isTTY) {
    process.stdout.write(`\n  ${DIVIDER}\n`);
    process.stdout.write(`  🚀  ${bold(title)}\n`);
    if (subtitle) process.stdout.write(`       ${subtitle}\n`);
    process.stdout.write(`  ${DIVIDER}\n\n`);
  } else {
    const subtitlePart = subtitle ? ` — ${subtitle}` : '';
    process.stdout.write(`\n=== ${title}${subtitlePart} ===\n\n`);
  }
}

export function outro(message: string, status: 'success' | 'error' = 'success'): void {
  if (isMockActive()) {
    recordCall('outro', message, status);
    return;
  }

  const icon = status === 'success' ? '✅' : '❌';
  const colorFn = status === 'success' ? green : red;

  if (isTTY) {
    process.stdout.write(`\n  ${DIVIDER}\n`);
    process.stdout.write(`  ${icon}  ${bold(colorFn(message))}\n`);
    process.stdout.write(`  ${DIVIDER}\n\n`);
  } else {
    process.stdout.write(`\n=== ${message} ===\n\n`);
  }
}
