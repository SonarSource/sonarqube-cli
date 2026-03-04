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

import { SonarQubeClient } from '../../sonarqube/client';
import { IssuesClient } from '../../sonarqube/issues';
import { encode as encodeToToon } from '@toon-format/toon';
import { formatTable } from '../../formatter/table';
import { formatCSV } from '../../formatter/csv';
import type { IssuesSearchParams } from '../../lib/types';
import { print } from '../../ui';
import { getActiveConnection, loadState } from '../../lib/state-manager';
import { getToken } from '../../lib/keychain';
import { MAX_PAGE_SIZE, ProjectsClient } from '../../sonarqube/projects';

const VALID_FORMATS = ['json', 'toon', 'table', 'csv'];
const VALID_SEVERITIES = ['INFO', 'MINOR', 'MAJOR', 'CRITICAL', 'BLOCKER'];

export interface ListIssuesOptions {
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
  pageSize: number;
  page: number;
}

/**
 * Issues search command handler
 */
export async function listIssues(options: ListIssuesOptions): Promise<void> {
  // Validate options before any auth/network operations
  const format = options.format ?? 'json';
  if (!VALID_FORMATS.includes(format.toLowerCase())) {
    throw new Error(`Invalid format: '${format}'. Must be one of: ${VALID_FORMATS.join(', ')}`);
  }

  const ps = options.pageSize;
  if (ps < 1 || ps > MAX_PAGE_SIZE) {
    throw new Error(`Invalid --page-size option: '${ps}'. Must be an integer between 1 and 500`);
  }

  const page = options.page;
  if (page < 1) {
    throw new Error(`Invalid --page option: '${page}'. Must be an integer >= 1`);
  }

  if (options.severity) {
    const sev = options.severity.toUpperCase();
    if (!VALID_SEVERITIES.includes(sev)) {
      throw new Error(
        `Invalid severity: '${options.severity}'. Must be one of: ${VALID_SEVERITIES.join(', ')}`,
      );
    }
  }

  if (!options.project) {
    throw new Error('--project is required');
  }

  const state = loadState();
  const activeConnection = getActiveConnection(state);

  if (!activeConnection) {
    throw new Error('No active connection found. Run: sonar auth login');
  }

  const token = await getToken(activeConnection.serverUrl, activeConnection.orgKey);
  if (!token) {
    throw new Error('No token found. Run: sonar auth login');
  }

  const client = new SonarQubeClient(activeConnection.serverUrl, token);
  const issuesClient = new IssuesClient(client);

  const params: IssuesSearchParams = {
    projects: options.project,
    organization: activeConnection.orgKey,
    severities: options.severity?.toUpperCase(),
    types: options.type,
    statuses: options.status,
    rules: options.rule,
    tags: options.tag,
    branch: options.branch,
    pullRequest: options.pullRequest,
    resolved: options.resolved,
    ps: options.pageSize,
    p: options.page,
  };

  const result = await issuesClient.searchIssues(params);

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
}

export interface ListProjectsOptions {
  query?: string;
  pageSize: number;
  page: number;
}

/**
 * Projects search command handler
 */
export async function listProjects(options: ListProjectsOptions): Promise<void> {
  const state = loadState();
  const activeConnection = getActiveConnection(state);

  if (!activeConnection) {
    throw new Error('No active connection found. Run: sonar auth login');
  }

  const token = await getToken(activeConnection.serverUrl, activeConnection.orgKey);
  if (!token) {
    throw new Error('No token found. Run: sonar auth login');
  }

  const pageSize = options.pageSize;
  if (pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new Error(
      `Invalid --page-size option: '${pageSize}'. Must be an integer between 1 and 500`,
    );
  }

  const page = options.page;
  if (page < 1) {
    throw new Error(`Invalid --page option: '${page}'. Must be an integer >= 1`);
  }

  const client = new SonarQubeClient(activeConnection.serverUrl, token);
  const projectsClient = new ProjectsClient(client);

  const result = await projectsClient.searchProjects({
    q: options.query,
    ps: pageSize,
    p: options.page,
    organization: activeConnection.orgKey,
  });

  const hasNextPage = result.paging.pageIndex * result.paging.pageSize < result.paging.total;

  print(
    JSON.stringify({
      projects: result.components.map((c) => ({ key: c.key, name: c.name })),
      paging: {
        pageIndex: result.paging.pageIndex,
        pageSize: result.paging.pageSize,
        total: result.paging.total,
        hasNextPage,
      },
    }),
  );
}
