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

// Integration tests for `sonar hook git-pre-commit`:
// graceful skips and end-to-end scan of staged files in a real local git repo.

import { chmodSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  HOOK_INACTIVE_UNAUTHENTICATED,
  SECRETS_INACTIVE_BINARY_MISSING,
} from '@/commands/hook/hook-dependencies.ts';
import { buildLocalBinaryName } from '@/core/host/install/secrets.ts';
import { detectPlatform } from '@/core/host/platform-detector.ts';

import { readCommandEvents } from '../../../_common/telemetry-helpers.ts';
import { TestHarness } from '../../harness';
import { initGitRepo, stageFile } from './git-test-helpers';

// Hardcoded test token — intentional fixture for secret detection, not a real credential
// sonar-ignore-next-line S6769
const GITHUB_TEST_TOKEN = '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';
const CLEAN_CONTENT = 'const greeting = "hello world";';

// Unreachable but well-formed server URL: binary handles connection-refused gracefully.
const FAKE_SERVER = 'http://localhost:19999';
const VALID_TOKEN = 'integration-test-token';
const TEST_ORG = 'my-org';
const PACKAGE_JSON_CONTENT = '{"name":"demo","version":"1.0.0"}';
const NON_EXECUTABLE_MODE = 0o644;

describe('sonar hook git-pre-commit', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'exits 0 when no files are staged',
    async () => {
      initGitRepo(harness.cwd.path);
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);

      const result = await harness.run('hook git-pre-commit');

      expect(result.exitCode).toBe(0);
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 outside of a git repo (graceful skip)',
    async () => {
      // cwd is not a git repo — git diff --cached will fail, getStagedFiles returns []
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);

      const result = await harness.run('hook git-pre-commit');

      expect(result.exitCode).toBe(0);
    },
    { timeout: 15000 },
  );

  it(
    'exits 1 with the unauthenticated message when not authenticated (fails closed)',
    async () => {
      initGitRepo(harness.cwd.path);
      harness.state().withSecretsBinaryInstalled();
      stageFile(harness.cwd.path, 'secret.js', `const token = "${GITHUB_TEST_TOKEN}";`);
      // No auth configured

      const result = await harness.run('hook git-pre-commit');

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(HOOK_INACTIVE_UNAUTHENTICATED);
    },
    { timeout: 15000 },
  );

  it(
    'exits 1 with the binary-missing message when binary is not installed (fails closed)',
    async () => {
      initGitRepo(harness.cwd.path);
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);
      stageFile(harness.cwd.path, 'secret.js', `const token = "${GITHUB_TEST_TOKEN}";`);
      // No binary installed

      const result = await harness.run('hook git-pre-commit');

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(SECRETS_INACTIVE_BINARY_MISSING);
    },
    { timeout: 15000 },
  );

  it(
    'exits 0 for a staged clean file',
    async () => {
      initGitRepo(harness.cwd.path);
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);
      stageFile(harness.cwd.path, 'clean.js', CLEAN_CONTENT);

      const result = await harness.run('hook git-pre-commit');

      expect(result.exitCode).toBe(0);
    },
    { timeout: 30000 },
  );

  it(
    'exits 1 when staged file contains a secret',
    async () => {
      initGitRepo(harness.cwd.path);
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);
      stageFile(harness.cwd.path, 'secret.js', `const token = "${GITHUB_TEST_TOKEN}";`);

      const result = await harness.run('hook git-pre-commit');

      expect(result.exitCode).toBe(1);
    },
    { timeout: 30000 },
  );

  it(
    'exits 1 when binary spawn fails with env-based auth (CI mode, fail hard)',
    async () => {
      initGitRepo(harness.cwd.path);
      stageFile(harness.cwd.path, 'clean.js', CLEAN_CONTENT);

      // Place a non-executable file at the binary path so spawnProcess throws
      const binaryName = buildLocalBinaryName(detectPlatform());
      harness.cliHome.writeFile(`bin/${binaryName}`, 'not-a-binary');
      chmodSync(harness.cliHome.file('bin', binaryName).path, NON_EXECUTABLE_MODE);

      const result = await harness.run('hook git-pre-commit', {
        extraEnv: { SONARQUBE_CLI_TOKEN: VALID_TOKEN, SONARQUBE_CLI_SERVER: FAKE_SERVER },
      });

      expect(result.exitCode).toBe(1);
    },
    { timeout: 30000 },
  );

  it(
    'exits 0 when binary spawn fails with keychain auth (local mode, fail soft)',
    async () => {
      initGitRepo(harness.cwd.path);
      harness.withAuth(FAKE_SERVER, VALID_TOKEN);
      stageFile(harness.cwd.path, 'clean.js', CLEAN_CONTENT);

      // Place a non-executable file at the binary path so spawnProcess throws
      const binaryName = buildLocalBinaryName(detectPlatform());
      harness.cliHome.writeFile(`bin/${binaryName}`, 'not-a-binary');
      chmodSync(harness.cliHome.file('bin', binaryName).path, NON_EXECUTABLE_MODE);

      const result = await harness.run('hook git-pre-commit');

      expect(result.exitCode).toBe(0);
    },
    { timeout: 30000 },
  );

  it(
    'exits 2 when --dependency-risks is set without -p',
    async () => {
      const result = await harness.run('hook git-pre-commit --dependency-risks');
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('-p');
    },
    { timeout: 15000 },
  );

  it(
    'reports project_uuid null for a secrets-only pre-commit (no -p passed)',
    async () => {
      initGitRepo(harness.cwd.path);
      stageFile(harness.cwd.path, 'index.ts', CLEAN_CONTENT);

      const server = await harness
        .newFakeServer()
        .withAuthToken(VALID_TOKEN)
        .withProject('demo')
        .start();

      harness.state().withTelemetryEnabled();
      harness.state().withSecretsBinaryInstalled();
      harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

      const result = await harness.run('hook git-pre-commit');

      expect(result.exitCode).toBe(0);
      // integrate only bakes `-p` into the hook alongside --dependency-risks, so a
      // secrets-only hook knows no project and must report null rather than guessing.
      const [commandEvent] = readCommandEvents(harness.sonarUserHome.path);
      expect(commandEvent.event_payload.subcommand).toBe('git-pre-commit');
      expect(commandEvent.event_payload.project_uuid).toBeNull();
    },
    { timeout: 30000 },
  );

  describe('with --dependency-risks', () => {
    it(
      'exits 1 with the unauthenticated message when not authenticated (fails closed)',
      async () => {
        initGitRepo(harness.cwd.path);
        harness.state().withScaScannerBinaryInstalled();
        stageFile(harness.cwd.path, 'package.json', PACKAGE_JSON_CONTENT);

        const result = await harness.run('hook git-pre-commit -p demo --dependency-risks');
        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(HOOK_INACTIVE_UNAUTHENTICATED);
      },
      { timeout: 15000 },
    );

    it(
      'exits 0 when sca-scanner binary is not installed (graceful skip)',
      async () => {
        initGitRepo(harness.cwd.path);
        harness.state().withSecretsBinaryInstalled();
        harness.withAuth(FAKE_SERVER, VALID_TOKEN, TEST_ORG);
        stageFile(harness.cwd.path, 'package.json', PACKAGE_JSON_CONTENT);

        const result = await harness.run('hook git-pre-commit -p demo --dependency-risks');
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain('sca-scanner binary not installed');
      },
      { timeout: 15000 },
    );

    it(
      'exits 0 when staged files contain no dependency manifests',
      async () => {
        initGitRepo(harness.cwd.path);
        harness.state().withSecretsBinaryInstalled();
        harness.state().withScaScannerBinaryInstalled();
        harness.withAuth(FAKE_SERVER, VALID_TOKEN, TEST_ORG);
        stageFile(harness.cwd.path, 'index.ts', CLEAN_CONTENT);

        const result = await harness.run('hook git-pre-commit -p demo --dependency-risks');

        expect(result.exitCode).toBe(0);
        expect(result.stdout + result.stderr).toContain(
          'No dependency manifests changed in this commit',
        );
      },
      { timeout: 30000 },
    );

    it(
      'records a non-null project_uuid on CliCommandExecuted',
      async () => {
        initGitRepo(harness.cwd.path);
        stageFile(harness.cwd.path, 'index.ts', CLEAN_CONTENT);

        const server = await harness
          .newFakeServer()
          .withAuthToken(VALID_TOKEN)
          .withScaEnabled(true)
          .withProject('demo')
          .withProjectSettings('demo', [])
          .start();

        // Do NOT enable flush mode: TELEMETRY_FLUSH_MODE_ENV no-ops storeEvent(), which owns
        // CliCommandExecuted, so the command event would never be written.
        harness.state().withTelemetryEnabled();
        harness.state().withSecretsBinaryInstalled();
        harness.state().withScaScannerBinaryInstalled();
        harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

        const result = await harness.run('hook git-pre-commit -p demo --dependency-risks');

        expect(result.exitCode).toBe(0);
        const [commandEvent] = readCommandEvents(harness.sonarUserHome.path);
        expect(commandEvent.event_payload.command).toBe('hook');
        expect(commandEvent.event_payload.subcommand).toBe('git-pre-commit');
        expect(commandEvent.event_payload.project_uuid).toBe('AYdemolegacy');
      },
      { timeout: 30000 },
    );

    it(
      'exits 1 when a staged file contains a secret (secrets scan runs before dependency-risks)',
      async () => {
        initGitRepo(harness.cwd.path);
        harness.state().withSecretsBinaryInstalled();
        harness.state().withScaScannerBinaryInstalled();
        harness.withAuth(FAKE_SERVER, VALID_TOKEN, TEST_ORG);
        stageFile(harness.cwd.path, 'secret.js', `const token = "${GITHUB_TEST_TOKEN}";`);

        const result = await harness.run('hook git-pre-commit -p demo --dependency-risks');

        expect(result.exitCode).toBe(1);
      },
      { timeout: 30000 },
    );

    it(
      'exits 0 (fail-open) when a manifest is staged but the SCA backend is unavailable',
      async () => {
        initGitRepo(harness.cwd.path);
        stageFile(harness.cwd.path, 'package.json', PACKAGE_JSON_CONTENT);

        const server = await harness
          .newFakeServer()
          .withAuthToken(VALID_TOKEN)
          .withScaEnabled(true)
          .withProject('demo')
          .withProjectSettings('demo', [])
          .start();
        harness.state().withSecretsBinaryInstalled();
        harness.state().withScaScannerBinaryInstalled();
        harness.withAuth(server.baseUrl(), VALID_TOKEN, TEST_ORG);

        const result = await harness.run('hook git-pre-commit -p demo --dependency-risks', {
          timeoutMs: 45_000,
        });

        // Hook is fail-open on scanner failure: warn on stderr, commit not blocked.
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain('Manifest discovery error:');
        expect(result.stderr).toContain('commit not blocked');
      },
      { timeout: 60000 },
    );
  });
});
