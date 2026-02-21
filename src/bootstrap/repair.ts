// Repair orchestrator - fixes configuration issues

import { generateTokenViaBrowser, saveToken, validateToken, deleteToken } from './auth.js';
import { installHooks, installSecretScanningHooks, type HookType } from './hooks.js';
import type { HealthCheckResult } from './health.js';
import logger from '../lib/logger.js';
import { text, success } from '../ui/index.js';

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
    text('Obtaining access token...');

    // Delete old token
    try {
      await deleteToken(serverURL, organization);
    } catch (error) {
      logger.debug(`Failed to delete token during repair: ${(error as Error).message}`);
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
    success('Token saved to keychain');
  }

  // Fix hooks if not installed
  if (!healthResult.hooksInstalled) {
    text('Installing hooks...');
    await installHooks(projectRoot, hookType);
    success('Hooks installed');
  }

  // Install sonar-secrets hooks for secret scanning
  text('Installing secret scanning hooks...');
  await installSecretScanningHooks(projectRoot);
  success('Secret scanning hooks installed');
}
