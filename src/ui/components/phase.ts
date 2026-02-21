// Phase component — process phase with status items

import { isTTY, bold, dim, STATUS_COLORS, STATUS_ICONS } from '../colors.js';
import { isMockActive, recordCall } from '../mock.js';
import type { PhaseItem, PhaseOptions, StepStatus, ColorFn } from '../types.js';

export type { PhaseItem, StepStatus } from '../types.js';

export function phaseItem(text: string, status: StepStatus, detail?: string): PhaseItem {
  return { text, status, detail };
}

function renderItem(item: PhaseItem, iconColors: Partial<Record<StepStatus, ColorFn>>): string {
  const colorFn: ColorFn = iconColors[item.status] ?? STATUS_COLORS[item.status];
  const icon = colorFn(STATUS_ICONS[item.status]);
  const detail = item.detail ? dim(`: ${item.detail}`) : '';
  return `    ${icon}  ${item.text}${detail}`;
}

export function phase(title: string, items: PhaseItem[], opts: PhaseOptions = {}): void {
  if (isMockActive()) { recordCall('phase', title, items); return; }

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
    }
    process.stdout.write('\n');
  }
}
