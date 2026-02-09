// Issues command - search for SonarQube issues

import { SonarQubeClient } from '../sonarqube/client.js';
import { IssuesClient } from '../sonarqube/issues.js';
import { getToken } from '../lib/keychain.js';
import { encodeToToon } from '../formatter/toon.js';
import { formatJSON } from '../formatter/json.js';
import { formatTable } from '../formatter/table.js';
import { formatCSV } from '../formatter/csv.js';
import type { IssuesSearchParams } from '../lib/types.js';

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
 * Issues search command handler
 */
export async function issuesSearchCommand(options: IssuesSearchOptions): Promise<void> {
  // Validate required options
  if (!options.server) {
    console.error('Error: --server is required');
    process.exit(1);
  }

  if (!options.project) {
    console.error('Error: --project is required');
    process.exit(1);
  }

  // Get token from keychain or option
  let token = options.token;
  if (!token) {
    const storedToken = await getToken(options.server);
    if (!storedToken) {
      console.error('Error: No token found. Use --token or run onboard-agent');
      process.exit(1);
    }
    token = storedToken;
  }

  // Create clients
  const client = new SonarQubeClient(options.server, token);
  const issuesClient = new IssuesClient(client);

  // Build search params
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
    ps: options.pageSize || 500,
    p: options.page || 1
  };

  try {
    // Search issues
    const result = options.all
      ? await issuesClient.searchAllIssues(params)
      : await issuesClient.searchIssues(params);

    // Format output
    const format = options.format || 'json';
    let output: string;

    switch (format.toLowerCase()) {
      case 'toon':
        output = encodeToToon(result);
        break;
      case 'json':
        output = formatJSON(result);
        break;
      case 'table':
        output = formatTable(result.issues);
        break;
      case 'csv':
        output = formatCSV(result.issues);
        break;
      default:
        console.error(`Unknown format: ${format}`);
        process.exit(1);
    }

    console.log(output);
  } catch (error) {
    console.error('Error searching issues:', (error as Error).message);
    process.exit(1);
  }
}
