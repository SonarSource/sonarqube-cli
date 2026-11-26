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

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { assertGithubComUrl, resolveDopSetting } from '@/commands/admin/onboard-ci/dop-setting.ts';
import { ENV_SONAR_USER_HOME } from '@/core/config-constants.ts';
import { clearNetworkConfigCache } from '@/core/host/connectivity/network-config.ts';
import { clearSecretCache } from '@/core/host/keychain.ts';
import { AccessDeniedError } from '@/core/server/errors.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';
import { type DopSetting, ProjectBindingsClient } from '@/core/server/project-bindings.ts';

import { restoreEnv } from '../../../_common/isolated-cli-env.ts';
import { isolateNetworkEnv } from '../../../_common/network-env.ts';
import { TestHarness } from '../../harness/index.js';

const GITHUB = {
  id: 'github-id',
  key: 'my-github',
  type: 'github',
  url: 'https://api.github.com',
} satisfies DopSetting;
const SECOND_GITHUB = { ...GITHUB, id: 'second-id', key: 'second-github' };
const ENTERPRISE = {
  ...GITHUB,
  id: 'enterprise-id',
  key: 'enterprise',
  url: 'https://github.example.com/api/v3',
};
const TOKEN = 'server-token';

describe('CI onboarding Server bindings', () => {
  let harness: TestHarness;
  let restoreNetworkEnv: () => void;
  let previousHome: string | undefined;
  let previousKeychain: string | undefined;

  beforeEach(async () => {
    harness = await TestHarness.create();
    restoreNetworkEnv = isolateNetworkEnv();
    previousHome = process.env[ENV_SONAR_USER_HOME];
    previousKeychain = process.env.SONARQUBE_CLI_KEYCHAIN_FILE;
    process.env[ENV_SONAR_USER_HOME] = harness.sonarUserHome.path;
    process.env.SONARQUBE_CLI_KEYCHAIN_FILE = harness.keychainJsonFile;
    clearNetworkConfigCache();
    clearSecretCache();
  });

  afterEach(async () => {
    try {
      await harness.dispose();
    } finally {
      clearNetworkConfigCache();
      clearSecretCache();
      restoreNetworkEnv();
      restoreEnv(ENV_SONAR_USER_HOME, previousHome);
      restoreEnv('SONARQUBE_CLI_KEYCHAIN_FILE', previousKeychain);
    }
  });

  const newServer = () => harness.newFakeServer().withAuthToken(TOKEN).withDopSettings([GITHUB]);
  const client = (url: string) => new ProjectBindingsClient(new SonarHttpClient(url, TOKEN));

  it('normalizes repository names and keeps bindings isolated to the selected integration', async () => {
    const server = await newServer()
      .withDopSettings([
        ENTERPRISE,
        GITHUB,
        { id: 'gitlab-id', key: 'gitlab', type: 'gitlab', url: 'https://gitlab.com' },
      ])
      .withProjectBindings([
        { repository: 'First-Org/Shared', projectKey: 'First-Project', dopSettingId: GITHUB.id },
        { repository: 'second-org/shared', projectKey: 'second-project', dopSettingId: GITHUB.id },
        {
          repository: 'First-Org/Shared',
          projectKey: 'another-integration',
          dopSettingId: ENTERPRISE.id,
        },
      ])
      .start();
    const bindings = client(server.baseUrl());

    const setting = await resolveDopSetting(bindings, 'github', GITHUB.key);
    expect(setting).toEqual(GITHUB);
    expect(await bindings.getAllProjectBindings(setting.id).orThrow()).toEqual(
      new Map([
        ['first-org/shared', 'First-Project'],
        ['second-org/shared', 'second-project'],
      ]),
    );
    expect(server.getRecordedRequests().every((request) => request.method === 'GET')).toBe(true);
  });

  it('explains how to configure GitHub when no integration exists', async () => {
    const server = await newServer().withDopSettings([]).start();
    const error = await resolveDopSetting(client(server.baseUrl()), 'github').catch(
      (error: unknown) => error,
    );
    expect(error).toMatchObject({
      exitCode: 1,
      message: expect.stringContaining('Administration > DevOps Platform Integrations > GitHub'),
    });
  });

  it('requires a name when GitHub.com and Enterprise integrations coexist', async () => {
    const server = await newServer().withDopSettings([GITHUB, ENTERPRISE]).start();
    const error = await resolveDopSetting(client(server.baseUrl()), 'github').catch(
      (error: unknown) => error,
    );
    expect(error).toMatchObject({ exitCode: 2 });
    expect(String(error)).toContain('--binding-name');
    expect(String(error)).toContain('my-github  (https://api.github.com)');
    expect(String(error)).toContain(`enterprise  (${ENTERPRISE.url})`);
  });

  it('selects the explicitly named configuration', async () => {
    const server = await newServer().withDopSettings([GITHUB, SECOND_GITHUB]).start();
    expect(await resolveDopSetting(client(server.baseUrl()), 'github', SECOND_GITHUB.key)).toEqual(
      SECOND_GITHUB,
    );
  });

  it('reports an unknown configuration name and the available choices', async () => {
    const server = await newServer().start();
    const error = await resolveDopSetting(
      client(server.baseUrl()),
      'github',
      'organization-name',
    ).catch((error: unknown) => error);
    expect(error).toMatchObject({ exitCode: 2 });
    expect(String(error)).toContain("configuration 'organization-name' not found");
    expect(String(error)).toContain(GITHUB.key);
  });

  it('rejects GitHub Enterprise configurations even when explicitly named', async () => {
    const server = await newServer().withDopSettings([ENTERPRISE]).start();
    const setting = await resolveDopSetting(client(server.baseUrl()), 'github', ENTERPRISE.key);
    expect(() => assertGithubComUrl(setting.url)).toThrow(
      'Only GitHub.com configurations (https://api.github.com) are supported.',
    );
  });

  it('propagates a settings API failure', async () => {
    const server = await newServer().withDopSettingsError(403).start();
    const error = await resolveDopSetting(client(server.baseUrl()), 'github').catch(
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(AccessDeniedError);
  });

  it('propagates a bindings API failure', async () => {
    const server = await newServer().withProjectBindingsStatus(403).start();
    const bindings = client(server.baseUrl());
    const setting = await resolveDopSetting(bindings, 'github');
    const error = await bindings
      .getAllProjectBindings(setting.id)
      .orThrow()
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AccessDeniedError);
  });
});
