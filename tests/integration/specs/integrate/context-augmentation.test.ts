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

// Integration tests for the Context Augmentation step inside `sonar integrate
// claude` and `sonar integrate copilot`.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { buildLocalCagBinaryName } from '../../../../src/cli/commands/_common/install/context-augmentation.js';
import { detectPlatform } from '../../../../src/lib/platform-detector.js';
import { SONAR_CONTEXT_AUGMENTATION_VERSION } from '../../../../src/lib/signatures.js';
import type { CliState } from '../../../../src/lib/state.js';
import { TestHarness } from '../../harness';
import {
  type CagInvocation,
  readCagInvocations as readInvocations,
} from '../../harness/cag-invocations';

function findInvocation(invocations: CagInvocation[], subcommand: string): CagInvocation {
  const match = invocations.find((i) => i.argv[0] === subcommand);
  if (!match) {
    throw new Error(
      `Expected sonar-context-augmentation '${subcommand}' invocation; got: ${JSON.stringify(invocations)}`,
    );
  }
  return match;
}

function loadState(harness: TestHarness): CliState {
  return harness.stateJsonFile.asJson() as CliState;
}

function expectContextEnv(invocation: CagInvocation, serverUrl: string): void {
  expect(invocation.env.SONAR_CONTEXT_TOKEN).toBe(TOKEN);
  expect(invocation.env.SONAR_CONTEXT_URL).toBe(serverUrl);
  expect(invocation.env.SONAR_CONTEXT_ORGANIZATION).toBe(ORG_KEY);
  expect(invocation.env.SONAR_CONTEXT_PROJECT).toBe(PROJECT_KEY);
}

const PROJECT_KEY = 'my-project';
const ORG_KEY = 'my-org';
const TOKEN = 'cloud-token';

describe('integrate claude — Context Augmentation', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    await harness.newFakeBinariesServer().start();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'invokes CAG tool integrate when project key + org are present',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(PROJECT_KEY)
        .withCagEntitlement(ORG_KEY)
        .withScaEnabled(true)
        .start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, TOKEN, ORG_KEY);
      harness.state().withContextAugmentationBinaryInstalled();
      harness.cwd.writeFile(
        'sonar-project.properties',
        [
          `sonar.host.url=${serverUrl}`,
          `sonar.projectKey=${PROJECT_KEY}`,
          `sonar.organization=${ORG_KEY}`,
        ].join('\n'),
      );

      const result = await harness.run('integrate claude --non-interactive', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
          SONAR_CONTEXT_ORGANIZATION: 'caller-org',
          SONAR_CONTEXT_PROJECT: 'caller-project',
          SONAR_CONTEXT_TOKEN: 'caller-token',
          SONAR_CONTEXT_URL: 'https://caller.example',
        },
      });

      expect(result.exitCode).toBe(0);
      const invocations = readInvocations(harness);
      const integrate = findInvocation(invocations, 'tool');
      expect(integrate.argv).toEqual([
        'tool',
        'integrate',
        '--agent',
        'claude-code',
        '--invocation-prefix',
        'sonar context',
        '--sca-enabled=true',
      ]);
      expectContextEnv(integrate, serverUrl);
      expect(result.stdout).not.toContain('Running: sonar-context-augmentation');
      expect(result.stdout).toContain(
        `✓  sonar-context-augmentation ${SONAR_CONTEXT_AUGMENTATION_VERSION}`,
      );

      // State records the skill extension
      const state = loadState(harness);
      const skillExt = state.agentExtensions.find(
        (e) => e.kind === 'skill' && e.name === 'sonar-context-augmentation',
      );
      expect(skillExt).toBeDefined();
      expect(skillExt?.agentId).toBe('claude-code');
      expect(skillExt?.kind === 'skill' && skillExt.scaEnabled).toBe(true);
    },
    { timeout: 30000 },
  );

  it(
    'passes --sca-enabled=false and warns when SCA enablement check fails',
    async () => {
      // No .withScaEnabled() call → fake server returns 404 for the SCA endpoint.
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(PROJECT_KEY)
        .withCagEntitlement(ORG_KEY)
        .start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, TOKEN, ORG_KEY);
      harness.state().withContextAugmentationBinaryInstalled();
      harness.cwd.writeFile(
        'sonar-project.properties',
        [
          `sonar.host.url=${serverUrl}`,
          `sonar.projectKey=${PROJECT_KEY}`,
          `sonar.organization=${ORG_KEY}`,
        ].join('\n'),
      );

      const result = await harness.run('integrate claude --non-interactive', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);
      const integrate = findInvocation(readInvocations(harness), 'tool');
      expect(integrate.argv).toContain('--sca-enabled=false');
      expect(result.stderr).toContain('Could not verify SCA availability');
      const state = loadState(harness);
      const skillExt = state.agentExtensions.find(
        (e) => e.kind === 'skill' && e.name === 'sonar-context-augmentation',
      );
      expect(skillExt?.kind === 'skill' && skillExt.scaEnabled).toBe(false);
    },
    { timeout: 30000 },
  );

  it(
    'skips CAG entirely when --skip-context is passed',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(PROJECT_KEY)
        .start();
      harness.withAuth(server.baseUrl(), TOKEN, ORG_KEY);
      harness.state().withContextAugmentationBinaryInstalled();
      harness.cwd.writeFile(
        'sonar-project.properties',
        [
          `sonar.host.url=${server.baseUrl()}`,
          `sonar.projectKey=${PROJECT_KEY}`,
          `sonar.organization=${ORG_KEY}`,
        ].join('\n'),
      );

      const result = await harness.run('integrate claude --non-interactive --skip-context');

      expect(result.exitCode).toBe(0);
      // No init/skill invocations — only --version probes (if any) are allowed
      const invocations = readInvocations(harness);
      const nonProbe = invocations.filter((i) => i.argv[0] !== '--version');
      expect(nonProbe).toEqual([]);
      const state = loadState(harness);
      const skillExt = state.agentExtensions.find(
        (e) => e.kind === 'skill' && e.name === 'sonar-context-augmentation',
      );
      expect(skillExt).toBeUndefined();
    },
    { timeout: 30000 },
  );

  it(
    'skips CAG with a warning when the org does not have it enabled',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(PROJECT_KEY)
        .withCagEntitlement(ORG_KEY, { enabled: false })
        .start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, TOKEN, ORG_KEY);
      harness.state().withContextAugmentationBinaryInstalled();
      harness.cwd.writeFile(
        'sonar-project.properties',
        [
          `sonar.host.url=${serverUrl}`,
          `sonar.projectKey=${PROJECT_KEY}`,
          `sonar.organization=${ORG_KEY}`,
        ].join('\n'),
      );

      const result = await harness.run('integrate claude --non-interactive', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);
      const nonProbe = readInvocations(harness).filter((i) => i.argv[0] !== '--version');
      expect(nonProbe).toEqual([]);
      const state = loadState(harness);
      expect(
        state.agentExtensions.find(
          (e) => e.kind === 'skill' && e.name === 'sonar-context-augmentation',
        ),
      ).toBeUndefined();
      expect(result.stderr).toContain('not enabled for your organization');
    },
    { timeout: 30000 },
  );

  it(
    'downloads, verifies, and extracts CAG when the binary is absent',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(PROJECT_KEY)
        .withCagEntitlement(ORG_KEY)
        .start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, TOKEN, ORG_KEY);
      harness.cwd.writeFile(
        'sonar-project.properties',
        [
          `sonar.host.url=${serverUrl}`,
          `sonar.projectKey=${PROJECT_KEY}`,
          `sonar.organization=${ORG_KEY}`,
        ].join('\n'),
      );

      // No withContextAugmentationBinaryInstalled() — let the install pipeline run.
      const result = await harness.run('integrate claude --non-interactive', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      // CAG init/skill may fail against the fake server; integrate is warn-on-failure.
      expect(result.exitCode).toBe(0);

      // The versioned binary must be on disk under <cliHome>/bin.
      const versionedName = buildLocalCagBinaryName(detectPlatform());
      expect(harness.cliHome.file('bin', versionedName).exists()).toBe(true);

      // state.json records the installation.
      const state = loadState(harness);
      const installed = state.tools?.installed.find((t) => t.name === 'sonar-context-augmentation');
      expect(installed).toBeDefined();
      expect(installed?.version).toMatch(/^\d+\.\d+/);
    },
    { timeout: 60000 },
  );

  it(
    'suppresses CAG stdout/stderr on success',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(PROJECT_KEY)
        .withCagEntitlement(ORG_KEY)
        .start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, TOKEN, ORG_KEY);
      harness.state().withContextAugmentationBinaryInstalled({
        stdoutLine: 'cag-stdout-diagnostic',
        stderrLine: 'cag-stderr-diagnostic',
      });
      harness.cwd.writeFile(
        'sonar-project.properties',
        [
          `sonar.host.url=${serverUrl}`,
          `sonar.projectKey=${PROJECT_KEY}`,
          `sonar.organization=${ORG_KEY}`,
        ].join('\n'),
      );

      const result = await harness.run('integrate claude --non-interactive', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain('cag-stdout-diagnostic');
      expect(result.stderr).not.toContain('cag-stderr-diagnostic');
    },
    { timeout: 30000 },
  );

  it(
    'surfaces indented CAG stdout/stderr when init fails',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(PROJECT_KEY)
        .withCagEntitlement(ORG_KEY)
        .start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, TOKEN, ORG_KEY);
      harness.state().withContextAugmentationBinaryInstalled({
        initExitCode: 1,
        stdoutLine: 'cag-stdout-diagnostic',
        stderrLine: 'cag-stderr-diagnostic',
      });
      harness.cwd.writeFile(
        'sonar-project.properties',
        [
          `sonar.host.url=${serverUrl}`,
          `sonar.projectKey=${PROJECT_KEY}`,
          `sonar.organization=${ORG_KEY}`,
        ].join('\n'),
      );

      const result = await harness.run('integrate claude --non-interactive', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('  cag-stdout-diagnostic');
      expect(result.stderr).toContain('  cag-stderr-diagnostic');
    },
    { timeout: 30000 },
  );

  it(
    'does not record the skill extension when CAG tool integrate fails',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(PROJECT_KEY)
        .withCagEntitlement(ORG_KEY)
        .start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, TOKEN, ORG_KEY);
      harness.state().withContextAugmentationBinaryInstalled({ initExitCode: 1 });
      harness.cwd.writeFile(
        'sonar-project.properties',
        [
          `sonar.host.url=${serverUrl}`,
          `sonar.projectKey=${PROJECT_KEY}`,
          `sonar.organization=${ORG_KEY}`,
        ].join('\n'),
      );

      const result = await harness.run('integrate claude --non-interactive', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      // CAG failures must not abort integrate
      expect(result.exitCode).toBe(0);
      const invocations = readInvocations(harness);
      const integrate = invocations.find((i) => i.argv[0] === 'tool');
      expect(integrate?.argv[1]).toBe('integrate');
      const state = loadState(harness);
      expect(
        state.agentExtensions.find(
          (e) => e.kind === 'skill' && e.name === 'sonar-context-augmentation',
        ),
      ).toBeUndefined();
    },
    { timeout: 30000 },
  );

  it(
    'skips CAG with a warning on SonarQube Cloud when no project key is configured',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withCagEntitlement(ORG_KEY)
        .start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, TOKEN, ORG_KEY);
      harness.state().withContextAugmentationBinaryInstalled();
      // No sonar-project.properties — projectKey is undefined.

      const result = await harness.run('integrate claude --non-interactive', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);
      const nonProbe = readInvocations(harness).filter((i) => i.argv[0] !== '--version');
      expect(nonProbe).toEqual([]);
      const state = loadState(harness);
      expect(
        state.agentExtensions.find(
          (e) => e.kind === 'skill' && e.name === 'sonar-context-augmentation',
        ),
      ).toBeUndefined();
      expect(result.stderr).toContain('a project key and organization are required');
    },
    { timeout: 30000 },
  );

  it(
    'emits info (not warn) and skips CAG on SonarQube Server without an org',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(PROJECT_KEY)
        .start();
      // No org — SonarQube Server auth
      harness.withAuth(server.baseUrl(), TOKEN);
      harness.state().withContextAugmentationBinaryInstalled();
      harness.cwd.writeFile(
        'sonar-project.properties',
        [`sonar.host.url=${server.baseUrl()}`, `sonar.projectKey=${PROJECT_KEY}`].join('\n'),
      );

      // No SONARQUBE_CLI_SONARCLOUD_URL override → localhost is treated as SQS
      const result = await harness.run('integrate claude --non-interactive');

      expect(result.exitCode).toBe(0);
      // No CAG subprocesses invoked
      const nonProbe = readInvocations(harness).filter((i) => i.argv[0] !== '--version');
      expect(nonProbe).toEqual([]);
      // "not available on SonarQube Server" info line must appear, not the
      // misleading "organization required" warning
      expect(result.stdout + result.stderr).toContain('not available on SonarQube Server');
      expect(result.stdout + result.stderr).not.toContain('organization are required');
    },
    { timeout: 30000 },
  );
});

describe('integrate copilot — Context Augmentation', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.state().withSecretsBinaryInstalled();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'invokes CAG with copilot agent identifier',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(PROJECT_KEY)
        .withCagEntitlement(ORG_KEY)
        .withScaEnabled(false)
        .start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, TOKEN, ORG_KEY);
      harness.state().withContextAugmentationBinaryInstalled();
      harness.cwd.writeFile(
        'sonar-project.properties',
        [
          `sonar.host.url=${serverUrl}`,
          `sonar.projectKey=${PROJECT_KEY}`,
          `sonar.organization=${ORG_KEY}`,
        ].join('\n'),
      );

      const result = await harness.run('integrate copilot', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);
      const invocations = readInvocations(harness);
      const integrate = findInvocation(invocations, 'tool');
      expect(integrate.argv).toEqual([
        'tool',
        'integrate',
        '--agent',
        'copilot',
        '--invocation-prefix',
        'sonar context',
        '--sca-enabled=false',
      ]);
      expectContextEnv(integrate, serverUrl);
      expect(result.stdout).not.toContain('Running: sonar-context-augmentation');

      // State records the skill extension under the internal Copilot agent id
      const state = loadState(harness);
      const skillExt = state.agentExtensions.find(
        (e) => e.kind === 'skill' && e.name === 'sonar-context-augmentation',
      );
      expect(skillExt).toBeDefined();
      expect(skillExt?.agentId).toBe('copilot-cli');
      expect(skillExt?.kind === 'skill' && skillExt.scaEnabled).toBe(false);
    },
    { timeout: 30000 },
  );
});

describe('integrate <agent> --global — Context Augmentation', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    harness.state().withSecretsBinaryInstalled();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it.each([
    ['claude', 'integrate claude -g --non-interactive'],
    ['copilot', 'integrate copilot -g'],
  ])(
    'skips CAG entirely on "integrate %s --global"',
    async (_agent, command) => {
      const server = await harness.newFakeServer().withAuthToken(TOKEN).start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, TOKEN, ORG_KEY);

      const result = await harness.run(command, {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);
      const nonProbe = readInvocations(harness).filter((i) => i.argv[0] !== '--version');
      expect(nonProbe).toEqual([]);
      const state = loadState(harness);
      expect(
        state.agentExtensions.find(
          (e) => e.kind === 'skill' && e.name === 'sonar-context-augmentation',
        ),
      ).toBeUndefined();
      expect(result.stderr).toContain('not supported with --global');
    },
    { timeout: 30000 },
  );
});
