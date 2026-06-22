/*
 * SonarQube CLI
 * Copyright (C) SonarSource Sàrl
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

/**
 * Shared helpers for e2e tests that run the real CLI against SonarQube Cloud
 * staging (EU + US): per-region config plus project create/delete over the Web
 * API.
 */

export type StagingRegion = 'eu' | 'us';

export const STAGING_REGIONS: StagingRegion[] = ['eu', 'us'];

interface RegionDescriptor {
  tokenEnv: string;
  org: string;
  serverUrl: string;
  apiUrl: string;
  cloudUrlEnv: string;
  cloudApiUrlEnv: string;
}

const REGIONS: Record<StagingRegion, RegionDescriptor> = {
  eu: {
    tokenEnv: 'SONARCLOUD_IT_TOKEN',
    org: 'sonarlint-it',
    serverUrl: 'https://sc-staging.io',
    apiUrl: 'https://api.sc-staging.io',
    cloudUrlEnv: 'SONARQUBE_CLI_SONARCLOUD_URL',
    cloudApiUrlEnv: 'SONARQUBE_CLI_SONARCLOUD_API_URL',
  },
  us: {
    tokenEnv: 'SONARCLOUD_IT_TOKEN_US',
    org: 'sonarlint-it',
    serverUrl: 'https://us-sc-staging.io',
    apiUrl: 'https://api.us-sc-staging.io',
    cloudUrlEnv: 'SONARQUBE_CLI_SONARCLOUD_US_URL',
    cloudApiUrlEnv: 'SONARQUBE_CLI_SONARCLOUD_US_API_URL',
  },
};

export interface StagingConfig {
  region: StagingRegion;
  token: string;
  org: string;
  serverUrl: string;
  hasCredentials: boolean;
  /**
   * Environment overrides that point the spawned CLI binary at staging. Pass as
   * `extraEnv` to `harness.run(...)`.
   */
  cliEnv: Record<string, string>;
}

/**
 * Resolves staging configuration for a region from the environment. Safe to
 * call at module load time; `hasCredentials` is false (rather than throwing)
 * when the token is missing so suites can `describe.skipIf(!cfg.hasCredentials)`.
 */
export function stagingConfig(region: StagingRegion): StagingConfig {
  const descriptor = REGIONS[region];
  const token = process.env[descriptor.tokenEnv] ?? '';
  return {
    region,
    token,
    org: descriptor.org,
    serverUrl: descriptor.serverUrl,
    hasCredentials: token.length > 0,
    cliEnv: {
      SONARQUBE_CLI_TOKEN: token,
      SONARQUBE_CLI_ORG: descriptor.org,
      SONARQUBE_CLI_SERVER: descriptor.serverUrl,
      [descriptor.cloudUrlEnv]: descriptor.serverUrl,
      [descriptor.cloudApiUrlEnv]: descriptor.apiUrl,
    },
  };
}

async function postForm(
  cfg: StagingConfig,
  path: string,
  params: Record<string, string>,
): Promise<Response> {
  return fetch(`${cfg.serverUrl}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
  });
}

/**
 * Provisions a project in the staging org via `POST api/projects/create`.
 * Throws on a non-2xx response so a setup failure aborts the test loudly.
 */
export async function createProject(cfg: StagingConfig, projectKey: string): Promise<void> {
  const response = await postForm(cfg, 'api/projects/create', {
    organization: cfg.org,
    project: projectKey,
    name: projectKey,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Failed to create staging project ${projectKey}: HTTP ${response.status} ${body}`,
    );
  }
}

/**
 * Deletes a staging project via `POST api/projects/bulk_delete`. Best-effort:
 * intended for `afterEach` teardown, so callers should ignore rejections.
 */
export async function deleteProject(cfg: StagingConfig, projectKey: string): Promise<void> {
  const response = await postForm(cfg, 'api/projects/bulk_delete', {
    organization: cfg.org,
    projects: projectKey,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Failed to delete staging project ${projectKey}: HTTP ${response.status} ${body}`,
    );
  }
}

/** Builds a unique project key for a test run. */
export function uniqueProjectKey(prefix: string): string {
  const random = Math.floor(Math.random() * 0x7fffffff);
  return `${prefix}-${random}`;
}
