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

import { TestHarness } from '../../harness';

const TOKEN = 'my-token';
const TIMEOUT = { timeout: 30000 };
const MEMBERSHIPS = [
  { key: 'first-org', name: 'First Org' },
  { key: 'second-org', name: 'Second Org' },
];

describe('auth login organization creation', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.withExtraEnv({ SONARQUBE_CLI_MOCK_TTY: 'true' });
  });

  afterEach(async () => {
    await harness.dispose();
  });

  async function startServer(count: number, rejected?: number) {
    const builder = harness
      .newFakeServer()
      .asSonarCloud()
      .withAuthToken(TOKEN)
      .withOrganizations(MEMBERSHIPS.slice(0, count));
    if (rejected) builder.withOrganizationCreateRejected(rejected);
    const server = await builder.start();
    harness.cwd.writeFile(
      'sonar-project.properties',
      `sonar.host.url=${server.recordedAuthServerUrl()}\n`,
    );
    return server;
  }

  it.each([0, 2])(
    'creates and signs in to a Free organization with %d existing memberships',
    async (count) => {
      const server = await startServer(count);
      const session = harness.runInteractive('auth login', {
        browserToken: TOKEN,
        browserTokenName: 'cli-browser-token',
      });
      if (count === 0) {
        await session.accept('Create an organization now?');
      } else {
        await session.waitText('Select an organization');
        for (let i = 0; i <= count; i++) session.keyDown();
        session.keyEnter();
      }
      await session.waitText('Organization name');
      session.write('Brand New Org');
      session.keyEnter();
      const result = await session.waitFinish();
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('brand-new-org');
      expect(
        server
          .getRecordedRequests()
          .filter((r) => r.method === 'POST' && r.path === '/api/organizations/create'),
      ).toHaveLength(1);
      expect(
        server
          .getRecordedRequests()
          .filter((r) => r.method === 'POST' && r.path === '/billing/subscriptions'),
      ).toHaveLength(1);
      const status = await harness.run('auth status');
      expect(status.stdout).toContain('brand-new-org');
    },
    TIMEOUT,
  );

  it(
    'automatically selects one organization without offering creation',
    async () => {
      const server = await startServer(1);
      const session = harness.runInteractive('auth login', {
        browserToken: TOKEN,
        browserTokenName: 'cli-browser-token',
      });
      const result = await session.waitFinish();
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Using organization (only member): first-org');
      expect(result.stdout).not.toContain('Select an organization');
      expect(result.stdout).not.toContain('Create an organization now?');
      expect(
        server
          .getRecordedRequests()
          .some((r) => r.method === 'POST' && r.path === '/api/organizations/create'),
      ).toBe(false);
      expect(
        server.getRecordedRequests().some((r) => r.path.startsWith('/billing/subscriptions')),
      ).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'creates nothing and fails login when an orgless user declines',
    async () => {
      const server = await startServer(0);
      const session = harness.runInteractive('auth login', {
        browserToken: TOKEN,
        browserTokenName: 'cli-browser-token',
      });
      await session.decline('Create an organization now?');
      const result = await session.waitFinish();
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "Join a SonarQube Cloud organization, then run 'sonar auth login' again.",
      );
      expect(server.getRecordedRequests().some((r) => r.path === '/api/organizations/create')).toBe(
        false,
      );
      expect(
        server.getRecordedRequests().filter((r) => r.path === '/api/user_tokens/revoke'),
      ).toHaveLength(1);
    },
    TIMEOUT,
  );

  it.each([403, 404])(
    'falls back to existing organizations when creation returns %d',
    async (status) => {
      const server = await startServer(2, status);
      const session = harness.runInteractive('auth login', {
        browserToken: TOKEN,
        browserTokenName: 'cli-browser-token',
      });
      await session.waitText('Select an organization');
      for (let i = 0; i < 3; i++) session.keyDown();
      session.keyEnter();
      await session.waitText('Organization name');
      session.write('Brand New Org');
      session.keyEnter();
      await session.accept('Select an organization');
      const result = await session.waitFinish();
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('Choose one of your organizations instead.');
      expect(
        server.getRecordedRequests().some((r) => r.path.startsWith('/billing/subscriptions')),
      ).toBe(false);
      const auth = await harness.run('auth status');
      expect(auth.stdout).toContain('first-org');
    },
    TIMEOUT,
  );
});
