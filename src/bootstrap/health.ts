// Health check orchestrator - validates configuration

import { validateToken } from './auth.js';
import { SonarQubeClient } from '../sonarqube/client.js';
import { isDockerRunning, hasImage } from './docker.js';
import { isMCPServerConfigured } from './mcp.js';
import { areHooksInstalled } from './hooks.js';

export interface HealthCheckResult {
  tokenValid: boolean;
  serverAvailable: boolean;
  projectAccessible: boolean;
  organizationAccessible: boolean;
  qualityProfilesAccessible: boolean;
  dockerRunning: boolean;
  dockerImagePresent: boolean;
  mcpConfigured: boolean;
  hooksInstalled: boolean;
  errors: string[];
}

/**
 * Run health checks
 */
export async function runHealthChecks(
  serverURL: string,
  token: string,
  projectKey: string,
  projectRoot: string,
  organization?: string
): Promise<HealthCheckResult> {
  const errors: string[] = [];

  // Check token
  console.log('   Validating token...');
  const tokenValid = await validateToken(serverURL, token);
  if (!tokenValid) {
    errors.push('Token is invalid');
  }

  // Check server
  console.log('   Checking server availability...');
  let serverAvailable = false;
  try {
    const client = new SonarQubeClient(serverURL, token);
    await client.getSystemStatus();
    serverAvailable = true;
  } catch (error) {
    errors.push(`Server unavailable: ${(error as Error).message}`);
  }

  // Check project
  console.log('   Verifying project access...');
  let projectAccessible = false;
  try {
    const client = new SonarQubeClient(serverURL, token);
    projectAccessible = await client.checkComponent(projectKey);
    if (!projectAccessible) {
      errors.push(`Project not accessible: ${projectKey}`);
    }
  } catch (error) {
    errors.push(`Failed to check project: ${(error as Error).message}`);
  }

  // Check organization (if specified)
  let organizationAccessible = true; // Default to true if not specified
  if (organization) {
    console.log('   Verifying organization access...');
    try {
      const client = new SonarQubeClient(serverURL, token);
      organizationAccessible = await client.checkOrganization(organization);
      if (!organizationAccessible) {
        errors.push(`Organization not accessible: ${organization}`);
      }
    } catch (error) {
      errors.push(`Failed to check organization: ${(error as Error).message}`);
    }
  }

  // Check quality profiles access
  console.log('   Verifying quality profiles access...');
  let qualityProfilesAccessible = false;
  try {
    const client = new SonarQubeClient(serverURL, token);
    qualityProfilesAccessible = await client.checkQualityProfiles(projectKey, organization);
    if (!qualityProfilesAccessible) {
      errors.push(`Quality profiles not accessible for project: ${projectKey}`);
    }
  } catch (error) {
    errors.push(`Failed to check quality profiles: ${(error as Error).message}`);
  }

  // Check Docker
  console.log('   Checking Docker status...');
  const dockerRunning = await isDockerRunning();
  if (!dockerRunning) {
    errors.push('Docker is not running');
  }

  const dockerImagePresent = await hasImage('mcp/sonarqube');
  if (!dockerImagePresent) {
    errors.push('Docker image mcp/sonarqube not found');
  }

  // Check MCP configuration in ~/.config/claude/mcp_settings.json
  console.log('   Checking MCP configuration...');
  const mcpConfigured = await isMCPServerConfigured(serverURL);
  if (!mcpConfigured) {
    errors.push('MCP Server not configured');
  }

  // Check hooks
  console.log('   Checking hooks installation...');
  const hooksInstalled = await areHooksInstalled(projectRoot);
  if (!hooksInstalled) {
    errors.push('Hooks not installed');
  }

  return {
    tokenValid,
    serverAvailable,
    projectAccessible,
    organizationAccessible,
    qualityProfilesAccessible,
    dockerRunning,
    dockerImagePresent,
    mcpConfigured,
    hooksInstalled,
    errors
  };
}
