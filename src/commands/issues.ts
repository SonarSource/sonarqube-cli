/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
 * mailto:info AT sonarsource DOT com
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 3 of the License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program; if not, write to the Free Software Foundation,
 * Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.
 */

// Issues command - search for SonarQube issues

import { SonarQubeClient } from '../sonarqube/client.js';
import { IssuesClient } from '../sonarqube/issues.js';
import { encode as encodeToToon } from '@toon-format/toon';
import { formatTable } from '../formatter/table.js';
import { formatCSV } from '../formatter/csv.js';
import type { IssuesSearchParams } from '../lib/types.js';
import { resolveAuth } from '../lib/auth-resolver.js';
import { runCommand } from '../lib/run-command.js';
import { print } from '../ui/index.js';

const DEFAULT_PAGE_SIZE = 500;

const VALID_FORMATS = ['json', 'toon', 'table', 'csv'];
const VALID_SEVERITIES = ['INFO', 'MINOR', 'MAJOR', 'CRITICAL', 'BLOCKER'];

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
  await runCommand(async () => {
    // Validate options before any auth/network operations
    const format = options.format ?? 'json';
    if (!VALID_FORMATS.includes(format.toLowerCase())) {
      throw new Error(`Invalid format: '${format}'. Must be one of: ${VALID_FORMATS.join(', ')}`);
    }

    if (options.pageSize !== undefined) {
      const ps = Number(options.pageSize);
      if (!Number.isInteger(ps) || ps < 1 || ps > DEFAULT_PAGE_SIZE) {
        throw new Error(`Invalid --page-size: '${options.pageSize}'. Must be an integer between 1 and 500`);
      }
    }

    if (options.severity) {
      const sev = options.severity.toUpperCase();
      if (!VALID_SEVERITIES.includes(sev)) {
        throw new Error(`Invalid severity: '${options.severity}'. Must be one of: ${VALID_SEVERITIES.join(', ')}`);
      }
    }

    if (!options.project) {
      throw new Error('--project is required');
    }

    const resolved = await resolveAuth({ token: options.token, server: options.server });

    try {
      new URL(resolved.serverUrl);
    } catch {
      throw new Error(`Invalid server URL: '${resolved.serverUrl}'. Provide a valid URL (e.g., https://sonarcloud.io)`);
    }

    const client = new SonarQubeClient(resolved.serverUrl, resolved.token);
    const issuesClient = new IssuesClient(client);

    const params: IssuesSearchParams = {
      projects: options.project,
      severities: options.severity?.toUpperCase(),
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
        output = JSON.stringify(result, null, 2);
    }

    print(output);
  });
}
