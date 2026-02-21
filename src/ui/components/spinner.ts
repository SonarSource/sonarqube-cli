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
