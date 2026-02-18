// Health check orchestrator - validates configuration

import { validateToken } from './auth.js';
import { SonarQubeClient } from '../sonarqube/client.js';
import { areHooksInstalled } from './hooks.js';
import logger from '../lib/logger.js';

export interface HealthCheckResult {
  tokenValid: boolean;
  serverAvailable: boolean;
  projectAccessible: boolean;
  organizationAccessible: boolean;
  qualityProfilesAccessible: boolean;
  hooksInstalled: boolean;
  errors: string[];
}

async function logAndValidate(message: string, validator: () => Promise<boolean>, errorMsg: string, errors: string[], verbose: boolean): Promise<boolean> {
  if (verbose) logger.info(`   ${message}`);
  try {
    const result = await validator();
    if (!result) errors.push(errorMsg);
    return result;
  } catch (error) {
    logger.debug(`Validation failed: ${(error as Error).message}`);
    errors.push(errorMsg);
    return false;
  }
}

/**
 * Run health checks
 */
export async function runHealthChecks(
  serverURL: string,
  token: string,
  projectKey: string,
  projectRoot: string,
  organization?: string,
  verbose: boolean = true
): Promise<HealthCheckResult> {
  const client = new SonarQubeClient(serverURL, token);
  const errors: string[] = [];

  const tokenValid = await logAndValidate(
    'Validating token...',
    () => validateToken(serverURL, token),
    'Token is invalid',
    errors,
    verbose
  );

  const serverAvailable = await logAndValidate(
    'Checking server availability...',
    async () => {
      await client.getSystemStatus();
      return true;
    },
    'Server unavailable',
    errors,
    verbose
  );

  const projectAccessible = await logAndValidate(
    'Verifying project access...',
    () => client.checkComponent(projectKey),
    `Project not accessible: ${projectKey}`,
    errors,
    verbose
  );

  let organizationAccessible = true;
  if (organization) {
    organizationAccessible = await logAndValidate(
      'Verifying organization access...',
      () => client.checkOrganization(organization),
      `Organization not accessible: ${organization}`,
      errors,
      verbose
    );
  }

  const qualityProfilesAccessible = await logAndValidate(
    'Verifying quality profiles access...',
    () => client.checkQualityProfiles(projectKey, organization),
    `Quality profiles not accessible for project: ${projectKey}`,
    errors,
    verbose
  );

  const hooksInstalled = await logAndValidate(
    'Checking hooks installation...',
    () => areHooksInstalled(projectRoot),
    'Hooks not installed',
    errors,
    verbose
  );

  return {
    tokenValid,
    serverAvailable,
    projectAccessible,
    organizationAccessible,
    qualityProfilesAccessible,
    hooksInstalled,
    errors
  };
}
