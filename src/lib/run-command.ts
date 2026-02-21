import logger from './logger.js';
import { error } from '../ui/index.js';

export async function runCommand(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    process.exit(0);
  } catch (err) {
    error((err as Error).message);
    logger.error((err as Error).message);
    process.exit(1);
  }
}
