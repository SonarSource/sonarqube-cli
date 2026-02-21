// Verify command - analyze a file using SonarCloud A3S API

import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { SonarQubeClient } from '../sonarqube/client.js';
import { encode as encodeToToon } from '@toon-format/toon';
import { getToken, getAllCredentials } from '../lib/keychain.js';
import { loadState, getActiveConnection } from '../lib/state-manager.js';
import { runCommand } from '../lib/run-command.js';
import { VERSION } from '../version.js';
import logger from '../lib/logger.js';
import { text, info, error, print } from '../ui/index.js';

// Hardcoded SonarCloud A3S API base URL
const SONARCLOUD_API_URL = 'https://api.sonarcloud.io';
const SONARCLOUD_URL = 'https://sonarcloud.io';
const TOON_FORMAT_THRESHOLD = 5; // Use TOON format for result sets larger than this

/**
 * Try to find projectKey from sonar-project.properties
 */
async function findProjectKeyInConfig(): Promise<string | undefined> {
  try {
    const { discoverProject } = await import('../bootstrap/discovery.js');
    const projectInfo = await discoverProject(process.cwd());

    if (projectInfo.sonarPropsData?.projectKey) {
      return projectInfo.sonarPropsData.projectKey;
    }

    return undefined;
  } catch {
    return undefined;
  }
}

export interface VerifyOptions {
  file: string;
  token?: string;
  organizationKey?: string;
  projectKey?: string;
  branch?: string;
  saveConfig?: boolean;
}

interface AnalyzeRequest {
  organizationKey: string;
  projectKey: string;
  filePath: string;
  fileContent: string;
  branch?: string;
}

interface AnalyzeResponse {
  issues?: Array<{
    ruleKey: string;
    message: string;
    severity: string;
    line?: number;
    column?: number;
  }>;
  status?: string;
  [key: string]: unknown;
}

/**
 * Try to get token from keychain for given organization
 */
async function getTokenFromKeychain(
  organizationKey: string
): Promise<string | undefined> {
  try {
    const token = await getToken(SONARCLOUD_URL, organizationKey);
    return token ?? undefined;
  } catch (err) {
    logger.debug(`Failed to retrieve token from keychain for org "${organizationKey}": ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * Try to get SonarCloud credential from saved state
 */
async function getCredentialFromSavedState(): Promise<
  { org: string; token: string } | undefined
> {
  try {
    const state = loadState(VERSION);
    const activeConnection = getActiveConnection(state);

    if (activeConnection?.type !== 'cloud' || !activeConnection?.orgKey) {
      return undefined;
    }

    const token = await getToken(activeConnection.serverUrl, activeConnection.orgKey);
    if (!token) {
      return undefined;
    }

    return { org: activeConnection.orgKey, token };
  } catch (err) {
    logger.debug(`Failed to retrieve credential from saved state: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * Try to get first SonarCloud credential from keychain
 */
async function getFirstSonarCloudCredential(): Promise<
  { org: string; token: string } | undefined
> {
  try {
    const allCreds = await getAllCredentials();
    const sonarCloudCreds = allCreds.filter(cred =>
      cred.account.startsWith('sonarcloud.io:')
    );

    if (sonarCloudCreds.length === 0) {
      return undefined;
    }

    const cred = sonarCloudCreds[0];
    const [, foundOrg] = cred.account.split(':');

    logMultipleOrganizationsIfFound(sonarCloudCreds.length, foundOrg);

    return { org: foundOrg, token: cred.password };
  } catch (err) {
    logger.debug(`Failed to retrieve credentials from keychain: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * Log a message if multiple organizations are found
 */
function logMultipleOrganizationsIfFound(count: number, org: string): void {
  if (count > 1) {
    info(`Multiple organizations found (${count}). Using: ${org}`);
    info('To use a different organization, specify --organization');
  }
}

/**
 * Try to fill missing token for given organization
 */
async function fillMissingToken(
  org: string,
  credentials: string | undefined
): Promise<string | undefined> {
  if (credentials) {
    return credentials;
  }
  return getTokenFromKeychain(org);
}

/**
 * Get credentials from keychain or environment
 */
async function getCredentials(
  organizationKey: string | undefined,
  token: string | undefined
): Promise<{ organizationKey: string | undefined; token: string | undefined }> {
  if (token && organizationKey) {
    return { organizationKey, token };
  }

  let org = organizationKey;
  let credentials = token;

  if (org) {
    const filledToken = await fillMissingToken(org, credentials);
    credentials = filledToken || credentials;
  }

  if (!credentials || !org) {
    // Try saved state first
    const savedState = await getCredentialFromSavedState();
    if (savedState) {
      org = org || savedState.org;
      credentials = credentials || savedState.token;
    } else {
      // Fall back to keychain
      const saved = await getFirstSonarCloudCredential();
      org = org || saved?.org;
      credentials = credentials || saved?.token;
    }
  }

  return { organizationKey: org, token: credentials };
}

/**
 * Validate configuration parameters
 */
function validateConfiguration(
  organizationKey: string | undefined,
  projectKey: string | undefined,
  token: string | undefined,
  file: string | undefined
): void {
  if (!file) {
    throw new Error('--file is required');
  }

  if (!organizationKey) {
    throw new Error('--organization-key is required. Provide via: --organization flag, or login with: sonar auth login');
  }

  if (!projectKey) {
    throw new Error('--project is required. Provide via: --project flag, or in sonar-project.properties');
  }

  if (!token) {
    throw new Error('--token is required. Provide via: --token flag, or login with: sonar auth login');
  }
}

/**
 * Read and validate file content
 */
function readFileContent(filePath: string): string {
  const absPath = resolve(filePath);

  if (!existsSync(absPath)) {
    throw new Error(`File not found: ${absPath}`);
  }

  return readFileSync(absPath, 'utf-8');
}

/**
 * Build request body for SonarCloud A3S API
 */
function buildAnalyzeRequest(
  organizationKey: string,
  projectKey: string,
  filePath: string,
  fileContent: string,
  branch?: string
): AnalyzeRequest {
  const request: AnalyzeRequest = {
    organizationKey,
    projectKey,
    filePath,
    fileContent
  };

  if (branch) {
    request.branch = branch;
  }

  return request;
}

/**
 * Format and output analysis results
 */
function formatResults(result: AnalyzeResponse): void {
  const issuesCount = result.issues?.length ?? 0;

  if (issuesCount > TOON_FORMAT_THRESHOLD) {
    print(encodeToToon(result));
  } else {
    print(JSON.stringify(result, null, 2));
  }
}

/**
 * Handle analysis errors with helpful troubleshooting
 */
function handleAnalysisError(analysisError: Error, organizationKey: string, projectKey: string): never {
  logger.error(`Analysis failed: ${analysisError.message}`);
  error([
    'Troubleshooting:',
    `  - Verify organization "${organizationKey}" has access to project "${projectKey}"`,
    '  - Check that your token has the correct permissions',
    `  - Try running: sonar auth logout --org ${organizationKey}`,
    `  - Then: sonar auth login --org ${organizationKey}`,
  ].join('\n'));
  throw analysisError;
}

/**
 * Check if connected server supports file analysis (Cloud only)
 */
function checkServerType(): void {
  let isOnPremise = false;

  try {
    const state = loadState(VERSION);
    const activeConnection = getActiveConnection(state);
    isOnPremise = activeConnection?.type === 'on-premise';
  } catch (err) {
    logger.debug(`Warning: Could not verify server type: ${(err as Error).message}`);
  }

  if (isOnPremise) {
    error('File analysis is not supported on SonarQube Server (on-premise)');
    error('File analysis via API is available only on SonarCloud.\n\nTo analyze files:\n  1. Switch to SonarCloud (https://sonarcloud.io)\n  2. Run: sonar auth login\n  3. Then retry: sonar verify --file <file>');
    throw new Error('File analysis is not supported on SonarQube Server (on-premise)');
  }
}

/**
 * Verify file command handler
 */
export async function verifyCommand(options: VerifyOptions): Promise<void> {
  await runCommand(async () => {
    // Check server type early
    checkServerType();

    const { organizationKey: org, token } = await getCredentials(
      options.organizationKey,
      options.token
    );

    // Try to find projectKey from flag first, then from config
    let projectKey = options.projectKey;
    if (!projectKey) {
      projectKey = await findProjectKeyInConfig();
    }

    validateConfiguration(org, projectKey, token, options.file);

    // After validateConfiguration, these are guaranteed to be defined
    if (!org || !projectKey || !token) {
      // This will never happen due to validateConfiguration, but TypeScript needs this check
      return;
    }

    const fileContent = readFileContent(options.file);
    const client = new SonarQubeClient(SONARCLOUD_API_URL, token);
    const requestBody = buildAnalyzeRequest(
      org,
      projectKey,
      options.file,
      fileContent,
      options.branch
    );

    try {
      text('Analyzing file...');
      const result = await client.post<AnalyzeResponse>(
        '/a3s-analysis/analyses',
        requestBody
      );
      formatResults(result);
    } catch (err) {
      handleAnalysisError(err as Error, org, projectKey);
    }
  });
}
