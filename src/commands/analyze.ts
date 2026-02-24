// Analyze command - scan for hardcoded secrets

import { secretCheckCommand } from './secret-scan.js';

export async function analyzeSecretsCommand(options: {
  file?: string;
  stdin?: boolean;
}): Promise<void> {
  return secretCheckCommand(options);
}
