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

// Integration tests for `list orgs` / `list org` — requires state connection + keychain token

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { TestHarness } from '../../harness';

describe('list orgs', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits with code 1 and prompts to authenticate when no auth is configured',
    async () => {
      const result = await harness.run('list orgs');

      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain('❌ Not authenticated.');
      expect(output).toContain("  → Run 'sonar auth login' to authenticate.");
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 and prompts to authenticate when connection exists but no keychain token',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('some-token').start();

      harness.state().withActiveConnection(server.baseUrl(), 'cloud', 'my-org');
      // No withKeychainToken — token absent from keychain

      const result = await harness.run('list orgs');

      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain('❌ Not authenticated.');
      expect(output).toContain("  → Run 'sonar auth login' to authenticate.");
    },
    { timeout: 15000 },
  );

  it(
    'returns JSON with organizations array (key, name, isAdmin, isActive) when connection and token are valid',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('valid-token')
        .withOrganizations([
          { key: 'org-a', name: 'Org A', actions: { admin: false } },
          { key: 'org-b', name: 'Org B', actions: { admin: true } },
        ])
        .start();

      harness.withAuth(server.baseUrl(), 'valid-token', 'org-a');

      const result = await harness.run('list orgs --format json');

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.organizations).toEqual([
        { key: 'org-a', name: 'Org A', isAdmin: false, isActive: true },
        { key: 'org-b', name: 'Org B', isAdmin: true, isActive: false },
      ]);
    },
    { timeout: 15000 },
  );

  it(
    "prints a header-less NAME/KEY/STATUS table, marking the active org and each other org's status",
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('valid-token')
        .withOrganizations([
          { key: 'org-a', name: 'Org A', actions: { admin: false } },
          { key: 'org-b', name: 'Org B', actions: { admin: true } },
          { key: 'org-c', name: 'Org C', actions: { admin: false } },
        ])
        .start();

      // org-a is the active connection's org: rendered as "active" regardless of its own admin flag.
      harness.withAuth(server.baseUrl(), 'valid-token', 'org-a');

      const result = await harness.run('list orgs');

      expect(result.exitCode).toBe(0);
      const lines = result.stdout.trim().split('\n');
      expect(lines).toHaveLength(3);
      expect(lines[0]).toMatch(/^Org A\s+org-a\s+active$/);
      expect(lines[1]).toMatch(/^Org B\s+org-b\s+Admin$/);
      expect(lines[2]).toMatch(/^Org C\s+org-c\s+Member$/);
    },
    { timeout: 15000 },
  );

  it(
    'moves the active organization to the first table row, keeping the rest in API order',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('valid-token')
        .withOrganizations([
          { key: 'org-a', name: 'Org A', actions: { admin: false } },
          { key: 'org-b', name: 'Org B', actions: { admin: true } },
          { key: 'org-c', name: 'Org C', actions: { admin: false } },
        ])
        .start();

      // org-b is active but sorts second in the API response: the table must still lead with it.
      harness.withAuth(server.baseUrl(), 'valid-token', 'org-b');

      const result = await harness.run('list orgs');

      expect(result.exitCode).toBe(0);
      const lines = result.stdout.trim().split('\n');
      expect(lines).toHaveLength(3);
      expect(lines[0]).toMatch(/^Org B\s+org-b\s+active$/);
      expect(lines[1]).toMatch(/^Org A\s+org-a\s+Member$/);
      expect(lines[2]).toMatch(/^Org C\s+org-c\s+Member$/);
    },
    { timeout: 15000 },
  );

  it(
    'keeps the API order in JSON — the active-first reorder only applies to the table view',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('valid-token')
        .withOrganizations([
          { key: 'org-a', name: 'Org A' },
          { key: 'org-b', name: 'Org B' },
        ])
        .start();

      harness.withAuth(server.baseUrl(), 'valid-token', 'org-b');

      const result = await harness.run('list orgs --format json');

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.organizations.map((o: { key: string }) => o.key)).toEqual(['org-a', 'org-b']);
    },
    { timeout: 15000 },
  );

  it(
    'prints "No organizations found" for an empty table result',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('valid-token')
        .withOrganizations([])
        .start();

      harness.withAuth(server.baseUrl(), 'valid-token', 'org-a');

      const result = await harness.run('list orgs');

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('No organizations found');
    },
    { timeout: 15000 },
  );

  it(
    'prints JSON with empty organizations array and zero total when no organizations exist',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('valid-token')
        .withOrganizations([])
        .start();

      harness.withAuth(server.baseUrl(), 'valid-token', 'org-a');

      const result = await harness.run('list orgs --format json');

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.organizations).toEqual([]);
      expect(parsed.paging).toEqual({
        pageIndex: 1,
        pageSize: 500,
        total: 0,
        hasNextPage: false,
      });
    },
    { timeout: 15000 },
  );

  it(
    'includes correct paging metadata with hasNextPage=true when more organizations exist',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('valid-token')
        .withOrganizations([{ key: 'org-a', name: 'Org A' }])
        .withOrganizationTotal(5)
        .start();

      harness.withAuth(server.baseUrl(), 'valid-token', 'org-a');

      const result = await harness.run('list orgs --format json --page 1 --page-size 1');

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.paging).toEqual({
        pageIndex: 1,
        pageSize: 1,
        total: 5,
        hasNextPage: true,
      });
    },
    { timeout: 15000 },
  );

  it(
    'includes correct paging metadata with hasNextPage=false on the last page',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('valid-token')
        .withOrganizations([{ key: 'org-a', name: 'Org A' }])
        .withOrganizationTotal(2)
        .start();

      harness.withAuth(server.baseUrl(), 'valid-token', 'org-a');

      const result = await harness.run('list orgs --format json --page 2 --page-size 1');

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.paging.hasNextPage).toBe(false);
    },
    { timeout: 15000 },
  );

  it(
    'passes page and page-size options to the API request',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('valid-token')
        .withOrganizations([{ key: 'org-a', name: 'Org A' }])
        .start();

      harness.withAuth(server.baseUrl(), 'valid-token', 'org-a');

      const result = await harness.run('list orgs --page 3 --page-size 50');

      expect(result.exitCode).toBe(0);
      const recorded = server.getRecordedRequests();
      const searchRequest = recorded.find(
        (r) => r.path === '/api/organizations/search' && r.query.member === 'true',
      );
      expect(searchRequest?.query.p).toBe('3');
      expect(searchRequest?.query.ps).toBe('50');
    },
    { timeout: 15000 },
  );

  it(
    'the "org" alias behaves the same as "orgs"',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('valid-token')
        .withOrganizations([{ key: 'org-a', name: 'Org A' }])
        .start();

      harness.withAuth(server.baseUrl(), 'valid-token', 'org-a');

      const result = await harness.run('list org --format json');

      expect(result.exitCode).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.organizations.map((o: { key: string }) => o.key)).toContain('org-a');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 when connected to SonarQube Server (not Cloud)',
    async () => {
      const server = await harness.newFakeServer().withAuthToken('valid-token').start();

      harness.withAuth(server.baseUrl(), 'valid-token');

      const result = await harness.run('list orgs');

      expect(result.exitCode).toBe(1);
      const output = result.stdout + result.stderr;
      expect(output).toContain('Organizations are only applicable to SonarQube Cloud connection.');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 when keychain token is invalid (401)',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken('correct-token')
        .withOrganizations([{ key: 'org-a', name: 'Org A' }])
        .start();

      harness.withAuth(server.baseUrl(), 'wrong-token', 'org-a');

      const result = await harness.run('list orgs');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain('401');
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 1 when --page-size is not a number',
    async () => {
      // Commander rejects non-integer before the action handler runs — no auth needed
      const result = await harness.run('list orgs --page-size abc');

      expect(result.exitCode).toBe(1);
      expect(result.stdout + result.stderr).toContain(
        "❌ error: option '--page-size <page-size>' argument 'abc' is invalid. Not a number.",
      );
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 2 when --page-size is 0',
    async () => {
      // Validation runs inside the handler — auth must pass first
      harness.withAuth('http://localhost:19999', 'fake-token', 'my-org');

      const result = await harness.run('list orgs --page-size 0');

      expect(result.exitCode).toBe(2);
      expect(result.stdout + result.stderr).toContain(
        "Invalid --page-size option: '0'. Must be an integer between 1 and 500",
      );
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 2 when --page-size exceeds 500',
    async () => {
      // Validation runs inside the handler — auth must pass first
      harness.withAuth('http://localhost:19999', 'fake-token', 'my-org');

      const result = await harness.run('list orgs --page-size 501');

      expect(result.exitCode).toBe(2);
      expect(result.stdout + result.stderr).toContain(
        "Invalid --page-size option: '501'. Must be an integer between 1 and 500",
      );
    },
    { timeout: 15000 },
  );

  it(
    'exits with code 2 when --page is 0',
    async () => {
      // Validation runs inside the handler — auth must pass first
      harness.withAuth('http://localhost:19999', 'fake-token', 'my-org');

      const result = await harness.run('list orgs --page 0');

      expect(result.exitCode).toBe(2);
      expect(result.stdout + result.stderr).toContain(
        "Invalid --page option: '0'. Must be an integer >= 1",
      );
    },
    { timeout: 15000 },
  );
});
