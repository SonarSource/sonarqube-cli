// Structural markers — intro, outro

import { isTTY, bold, green, red } from '../colors.js';
import { isMockActive, recordCall } from '../mock.js';

const DIVIDER_WIDTH = 40 + 2; // 40 base + 2 for indent alignment
const DIVIDER = '━'.repeat(DIVIDER_WIDTH);

export function intro(title: string, subtitle?: string): void {
  if (isMockActive()) { recordCall('intro', title, subtitle); return; }

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
  if (isMockActive()) { recordCall('outro', message, status); return; }

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
