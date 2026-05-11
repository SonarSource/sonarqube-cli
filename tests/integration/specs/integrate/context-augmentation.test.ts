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

import type { CliState } from '../../../../src/lib/state.js';
import { TestHarness } from '../../harness';

interface CagInvocation {
  argv: string[];
  env: { SONAR_TOKEN?: string };
}

function readInvocations(harness: TestHarness): CagInvocation[] {
  const file = harness.cliHome.file('cag-invocations.jsonl');
  if (!file.exists()) return [];
  return file
    .asText()
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CagInvocation);
}

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
    'invokes CAG init and skill --install when project key + org are present',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(PROJECT_KEY)
        .withCagEntitlement(ORG_KEY)
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

      const result = await harness.run('integrate claude --non-interactive');

      expect(result.exitCode).toBe(0);
      const invocations = readInvocations(harness);
      // Sanity: ignore any --version probe, find init and skill invocations
      const init = findInvocation(invocations, 'init');
      const skill = findInvocation(invocations, 'skill');
      expect(init.argv).toEqual([
        'init',
        '--org',
        ORG_KEY,
        '--project-key',
        PROJECT_KEY,
        '--skip-skill-install',
      ]);
      expect(init.env.SONAR_TOKEN).toBe(TOKEN);
      expect(skill.argv).toEqual([
        'skill',
        '--install',
        'claude-code',
        '--invocation-prefix',
        'sonar context',
      ]);
      expect(skill.env.SONAR_TOKEN).toBe(TOKEN);

      // State records the skill extension
      const state = loadState(harness);
      const skillExt = state.agentExtensions.find(
        (e) => e.kind === 'skill' && e.name === 'sonar-context-augmentation',
      );
      expect(skillExt).toBeDefined();
      expect(skillExt?.agentId).toBe('claude-code');
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

      const result = await harness.run('integrate claude --non-interactive');

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
    'does not record the skill extension when CAG init fails',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(PROJECT_KEY)
        .withCagEntitlement(ORG_KEY)
        .start();
      harness.withAuth(server.baseUrl(), TOKEN, ORG_KEY);
      harness.state().withContextAugmentationBinaryInstalled({ initExitCode: 1 });
      harness.cwd.writeFile(
        'sonar-project.properties',
        [
          `sonar.host.url=${server.baseUrl()}`,
          `sonar.projectKey=${PROJECT_KEY}`,
          `sonar.organization=${ORG_KEY}`,
        ].join('\n'),
      );

      const result = await harness.run('integrate claude --non-interactive');

      // CAG failures must not abort integrate
      expect(result.exitCode).toBe(0);
      const invocations = readInvocations(harness);
      expect(invocations.find((i) => i.argv[0] === 'init')).toBeDefined();
      expect(invocations.find((i) => i.argv[0] === 'skill')).toBeUndefined();
      const state = loadState(harness);
      expect(
        state.agentExtensions.find(
          (e) => e.kind === 'skill' && e.name === 'sonar-context-augmentation',
        ),
      ).toBeUndefined();
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

      const result = await harness.run('integrate copilot');

      expect(result.exitCode).toBe(0);
      const skill = findInvocation(readInvocations(harness), 'skill');
      expect(skill.argv).toEqual([
        'skill',
        '--install',
        'copilot',
        '--invocation-prefix',
        'sonar context',
      ]);
    },
    { timeout: 30000 },
  );
});
