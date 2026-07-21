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

// Phase component — process phase with status items

import { bold, dim, isTTY, STATUS_COLORS, STATUS_ICONS } from '../colors.ts';
import { isMockActive, recordCall } from '../mock.ts';
import type { ColorFn, PhaseItem, PhaseOptions, StepStatus } from '../types.ts';

export type { PhaseItem, StepStatus } from '../types.ts';

export function phaseItem(
  text: string,
  status: StepStatus,
  detail?: string,
  subItems?: string[],
): PhaseItem {
  return { text, status, detail, subItems };
}

function renderItem(item: PhaseItem, iconColors: Partial<Record<StepStatus, ColorFn>>): string {
  const colorFn: ColorFn = iconColors[item.status] ?? STATUS_COLORS[item.status];
  const icon = colorFn(STATUS_ICONS[item.status]);
  const detail = item.detail ? dim(`: ${item.detail}`) : '';
  const lines = [`    ${icon}  ${item.text}${detail}`];
  for (const subItem of item.subItems ?? []) {
    lines.push(dim(`       ${subItem}`));
  }
  return lines.join('\n');
}

export function phase(title: string, items: PhaseItem[], opts: PhaseOptions = {}): void {
  if (isMockActive()) {
    recordCall('phase', title, items);
    return;
  }

  const titleColor: ColorFn = opts.titleColor ?? bold;
  const iconColors = opts.iconColors ?? {};

  if (isTTY) {
    process.stdout.write(`\n  ${titleColor(title)}\n`);
    for (const item of items) {
      process.stdout.write(renderItem(item, iconColors) + '\n');
    }
    process.stdout.write('\n');
  } else {
    process.stdout.write(`\n${title}\n`);
    for (const item of items) {
      const icon = STATUS_ICONS[item.status];
      const detail = item.detail ? `: ${item.detail}` : '';
      process.stdout.write(`  ${icon}  ${item.text}${detail}\n`);
      for (const subItem of item.subItems ?? []) {
        process.stdout.write(`       ${subItem}\n`);
      }
    }
    process.stdout.write('\n');
  }
}
