// Verify command - analyze a file using SonarCloud A3S API

import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { SonarQubeClient } from '../sonarqube/client.js';
import { encode as encodeToToon } from '@toon-format/toon';
import { loadState, getActiveConnection } from '../lib/state-manager.js';
import { resolveAuth } from '../lib/auth-resolver.js';
import { runCommand } from '../lib/run-command.js';
import { VERSION } from '../version.js';
import logger from '../lib/logger.js';
import { text, error, print } from '../ui/index.js';

import { SONARCLOUD_URL, SONARCLOUD_HOSTNAME } from '../lib/config-constants.js';

const TOON_FORMAT_THRESHOLD = 5; // Use TOON format for result sets larger than this

/**
 * Map serverUrl to its A3S API base URL.
 * SonarCloud uses a separate api subdomain; other servers use the URL as-is.
 */
function getA3sApiUrl(serverUrl: string): string {
  try {
    const { hostname } = new URL(serverUrl);
    if (hostname === SONARCLOUD_HOSTNAME) {
      return `https://api.${hostname}`;
    }
  } catch {
    // fall through
  }
  return serverUrl;
}

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

    const resolved = await resolveAuth({
      token: options.token,
      server: SONARCLOUD_URL,
      org: options.organizationKey,
    });

    // Try to find projectKey from flag first, then from config
    let projectKey = options.projectKey;
    if (!projectKey) {
      projectKey = await findProjectKeyInConfig();
    }

    validateConfiguration(resolved.orgKey, projectKey, resolved.token, options.file);

    // After validateConfiguration, these are guaranteed to be defined
    if (!resolved.orgKey || !projectKey) {
      // This will never happen due to validateConfiguration, but TypeScript needs this check
      return;
    }

    const fileContent = readFileContent(options.file);
    const client = new SonarQubeClient(getA3sApiUrl(resolved.serverUrl), resolved.token);
    const requestBody = buildAnalyzeRequest(
      resolved.orgKey,
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
      handleAnalysisError(err as Error, resolved.orgKey, projectKey);
    }
  });
}
