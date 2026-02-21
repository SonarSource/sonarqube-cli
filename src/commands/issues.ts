// Issues command - search for SonarQube issues

import { SonarQubeClient } from '../sonarqube/client.js';
import { IssuesClient } from '../sonarqube/issues.js';
import { getToken } from '../lib/keychain.js';
import { encode as encodeToToon } from '@toon-format/toon';
import { formatTable } from '../formatter/table.js';
import { formatCSV } from '../formatter/csv.js';
import type { IssuesSearchParams } from '../lib/types.js';
import { loadState, getActiveConnection } from '../lib/state-manager.js';
import { runCommand } from '../lib/run-command.js';
import { VERSION } from '../version.js';
import { print } from '../ui';

const DEFAULT_PAGE_SIZE = 500;

export interface IssuesSearchOptions {
  server?: string;
  token?: string;
  project?: string;
  severity?: string;
  type?: string;
  status?: string;
  rule?: string;
  tag?: string;
  branch?: string;
  pullRequest?: string;
  resolved?: boolean;
  format?: string;
  all?: boolean;
  pageSize?: number;
  page?: number;
}

/**
 * Get server URL from saved state if available
 */
function getServerFromState(): string | undefined {
  try {
    const state = loadState(VERSION);
    const activeConnection = getActiveConnection(state);
    return activeConnection?.serverUrl;
  } catch {
    return undefined;
  }
}

/**
 * Issues search command handler
 */
export async function issuesSearchCommand(options: IssuesSearchOptions): Promise<void> {
  await runCommand(async () => {
    const server = options.server ?? getServerFromState();
    if (!server) {
      throw new Error('--server is required. Provide via: --server flag, or login with: sonar auth login');
    }

    if (!options.project) {
      throw new Error('--project is required');
    }

    let token = options.token;
    if (!token) {
      const storedToken = await getToken(server);
      if (!storedToken) {
        throw new Error('No token found. Use --token or run: sonar auth login');
      }
      token = storedToken;
    }

    const client = new SonarQubeClient(server, token);
    const issuesClient = new IssuesClient(client);

    const params: IssuesSearchParams = {
      projects: options.project,
      severities: options.severity,
      types: options.type,
      statuses: options.status,
      rules: options.rule,
      tags: options.tag,
      branch: options.branch,
      pullRequest: options.pullRequest,
      resolved: options.resolved,
      ps: options.pageSize ?? DEFAULT_PAGE_SIZE,
      p: options.page ?? 1
    };

    const result = options.all
      ? await issuesClient.searchAllIssues(params)
      : await issuesClient.searchIssues(params);

    const format = options.format ?? 'json';
    let output: string;

    switch (format.toLowerCase()) {
      case 'toon':
        output = encodeToToon(result);
        break;
      case 'json':
        output = JSON.stringify(result, null, 2);
        break;
      case 'table':
        output = formatTable(result.issues);
        break;
      case 'csv':
        output = formatCSV(result.issues);
        break;
      default:
        throw new Error(`Unknown format: ${format}`);
    }

    print(output);
  });
}
