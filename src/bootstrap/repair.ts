// Repair orchestrator - fixes configuration issues

import { generateTokenViaBrowser, saveToken, validateToken, deleteToken } from './auth.js';
import { installHooks, type HookType } from './hooks.js';
import type { HealthCheckResult } from './health.js';
import logger from '../lib/logger.js';

/**
 * Run repair actions based on health check results
 */
export async function runRepair(
  serverURL: string,
  projectRoot: string,
  healthResult: HealthCheckResult,
  projectKey?: string,
  organization?: string,
  hookType: HookType = 'prompt'
): Promise<void> {
  let token = '';

  // Fix token if invalid
  if (!healthResult.tokenValid) {
    logger.info('\n→ 🔑 Obtaining access token...');

    // Delete old token
    try {
      await deleteToken(serverURL, organization);
    } catch {
      // Ignore errors
    }

    // Generate new token
    token = await generateTokenViaBrowser(serverURL);

    // Validate new token
    const valid = await validateToken(serverURL, token);
    if (!valid) {
      throw new Error('Generated token is invalid');
    }

    // Save to keychain
    await saveToken(serverURL, token, organization);
    logger.info('   ✓ Token saved to keychain');
  }

  // Fix hooks if not installed
  if (!healthResult.hooksInstalled) {
    logger.info('\n→ 🪝 Installing hooks...');
    await installHooks(projectRoot, hookType);
    logger.info('   ✓ Hooks installed');
  }
}
