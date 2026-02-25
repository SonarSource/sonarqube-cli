// Projects command - search for SonarQube projects

import { SonarQubeClient } from '../sonarqube/client.js';
import { ProjectsClient, MAX_PAGE_SIZE } from '../sonarqube/projects.js';
import { getToken } from '../lib/keychain.js';
import { loadState, getActiveConnection } from '../lib/state-manager.js';
import { version as VERSION } from '../../package.json';
import { print } from '../ui/index.js';

export interface ProjectsSearchOptions {
  query?: string;
  pageSize?: number;
  page?: number;
}

/**
 * Projects search command handler
 */
export async function projectsSearchCommand(options: ProjectsSearchOptions): Promise<void> {
  const state = loadState(VERSION);
  const activeConnection = getActiveConnection(state);

  if (!activeConnection) {
    throw new Error('No active connection found. Run: sonar auth login');
  }

  const token = await getToken(activeConnection.serverUrl, activeConnection.orgKey);
  if (!token) {
    throw new Error('No token found. Run: sonar auth login');
  }

  const pageSize = options.pageSize ?? MAX_PAGE_SIZE;
  if (pageSize <= 0 || pageSize > MAX_PAGE_SIZE) {
    throw new Error(`--page-size must be greater than 0 and less than or equal to ${MAX_PAGE_SIZE}`);
  }

  const client = new SonarQubeClient(activeConnection.serverUrl, token);
  const projectsClient = new ProjectsClient(client);

  const result = await projectsClient.searchProjects({
    q: options.query,
    ps: pageSize,
    p: options.page ?? 1,
    organization: activeConnection.orgKey
  });

  const hasNextPage = (result.paging.pageIndex * result.paging.pageSize) < result.paging.total;

  print(JSON.stringify({
    projects: result.components.map(c => ({ key: c.key, name: c.name })),
    paging: {
      pageIndex: result.paging.pageIndex,
      pageSize: result.paging.pageSize,
      total: result.paging.total,
      hasNextPage
    }
  }));
}
