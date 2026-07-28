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
// claude`, `sonar integrate copilot`, and `sonar integrate codex`.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { buildLocalCagBinaryName } from '@/commands/_common/install/context-augmentation.js';
import { CONTEXT_AUGMENTATION_FEATURE_ID } from '@/commands/integrate/_common/features/context-augmentation-feature.js';
import { CLAUDE_INTEGRATION_ID } from '@/commands/integrate/claude/declaration.js';
import { CODEX_INTEGRATION_ID } from '@/commands/integrate/codex/declaration.js';
import { COPILOT_INTEGRATION_ID } from '@/commands/integrate/copilot/declaration.js';
import { detectPlatform } from '@/core/host/platform-detector.ts';
import { SONAR_CONTEXT_AUGMENTATION_VERSION } from '@/core/host/signatures.ts';
import { pathComparisonKey } from '@/core/io/fs-utils.ts';
import type { CliState, InstalledIntegrationFeature } from '@/core/state/state.ts';

import { hookScriptName, TestHarness } from '../../harness';
import {
  type CagInvocation,
  readCagInvocations as readInvocations,
} from '../../harness/cag-invocations';
import { commitFile, git, initGitRepo } from '../hook/git-test-helpers';

function findToolInvocation(invocations: CagInvocation[], subcommand: string): CagInvocation {
  const match = invocations.find((i) => i.argv[0] === 'tool' && i.argv[1] === subcommand);
  if (!match) {
    throw new Error(
      `Expected sonar-context-augmentation 'tool ${subcommand}' invocation; got: ${JSON.stringify(invocations)}`,
    );
  }
  return match;
}

function loadState(harness: TestHarness): CliState {
  return harness.stateJsonFile.asJson() as CliState;
}

interface RecordedCagFeature {
  integrationId: string;
  feature: InstalledIntegrationFeature;
}

function findRecordedCagFeature(
  state: CliState,
  integrationId?: string,
): RecordedCagFeature | undefined {
  for (const integration of state.integrations.installed) {
    if (integrationId && integration.integrationId !== integrationId) {
      continue;
    }
    for (const feature of integration.features) {
      if (feature.featureId !== CONTEXT_AUGMENTATION_FEATURE_ID) {
        continue;
      }
      return {
        integrationId: integration.integrationId,
        feature,
      };
    }
  }
  return undefined;
}

function expectRecordedCagFeature(
  state: CliState,
  args: {
    integrationId: string;
    projectRoot: string;
    scaEnabled: boolean;
    serverUrl: string;
  },
): void {
  const entry = findRecordedCagFeature(state, args.integrationId);
  expect(entry).toBeDefined();
  if (!entry) {
    return;
  }
  expect(entry.integrationId).toBe(args.integrationId);
  expect(entry.feature.scope).toBe('project');
  expect(entry.feature.targetRoot).toBe(args.projectRoot);
  expect(entry.feature.attrs).toMatchObject({
    orgKey: ORG_KEY,
    projectKey: PROJECT_KEY,
    scaEnabled: args.scaEnabled,
    serverUrl: args.serverUrl,
  });
}

function expectContextEnv(invocation: CagInvocation, serverUrl: string): void {
  expect(invocation.env.SONAR_CONTEXT_TOKEN).toBe(TOKEN);
  expect(invocation.env.SONAR_CONTEXT_URL).toBe(serverUrl);
  expect(invocation.env.SONAR_CONTEXT_ORGANIZATION).toBe(ORG_KEY);
  expect(invocation.env.SONAR_CONTEXT_PROJECT).toBe(PROJECT_KEY);
  expect(invocation.env.SONAR_CONTEXT_INVOCATION_ID).toMatch(UUID_V4_RE);
}

function expectPrintSkillContextEnv(invocation: CagInvocation): void {
  // print-skill receives only the recorded organization (drives CAG's
  // dogfooding-tools gating in the rendered skill); project/url/token are
  // intentionally omitted, and the caller's SONAR_CONTEXT_* env must not leak
  // into the render.
  expect(invocation.env.SONAR_CONTEXT_ORGANIZATION).toBe(ORG_KEY);
  expect(invocation.env.SONAR_CONTEXT_PROJECT).toBeUndefined();
  expect(invocation.env.SONAR_CONTEXT_TOKEN).toBeUndefined();
  expect(invocation.env.SONAR_CONTEXT_URL).toBeUndefined();
}

function expectSkillFile(harness: TestHarness, relativePath: string, scaEnabled: boolean): void {
  const file = harness.cwd.file(relativePath);
  expect(file.exists()).toBe(true);
  expect(file.asText()).toContain(
    `# Generated CAG skill\n--sca-enabled=${scaEnabled ? 'true' : 'false'}`,
  );
}

interface ClaudeHookCommand {
  type?: string;
  command?: string;
  timeout?: number;
}

interface ClaudeHookEntry {
  matcher?: string;
  hooks?: ClaudeHookCommand[];
}

interface ClaudeSettings {
  hooks?: {
    PreToolUse?: ClaudeHookEntry[];
    PostToolUse?: ClaudeHookEntry[];
    PostToolUseFailure?: ClaudeHookEntry[];
  };
}

type HarnessRoot = 'cwd' | 'userHome';

function readClaudeSettings(harness: TestHarness, root: HarnessRoot): ClaudeSettings | undefined {
  const file = harness[root].file('.claude', 'settings.json');
  if (!file.exists()) {
    return undefined;
  }
  return file.asJson() as ClaudeSettings;
}

function claudeCagHookEntries(
  settings: ClaudeSettings | undefined,
  eventType: keyof NonNullable<ClaudeSettings['hooks']>,
): ClaudeHookEntry[] {
  return (settings?.hooks?.[eventType] ?? []).filter((entry) =>
    entry.hooks?.some((hook) => hook.command?.includes(CLAUDE_CAG_HOOK_MARKER)),
  );
}

function claudeCagPostToolEntries(settings: ClaudeSettings | undefined): ClaudeHookEntry[] {
  return claudeCagHookEntries(settings, 'PostToolUse');
}

function claudeSqaaPostToolEntries(settings: ClaudeSettings | undefined): ClaudeHookEntry[] {
  return (settings?.hooks?.PostToolUse ?? []).filter((entry) =>
    entry.hooks?.some((hook) => hook.command?.includes('sonar-sqaa')),
  );
}

function expectClaudeCagHookInstalled(harness: TestHarness): void {
  const script = harness.cwd.file(CLAUDE_CAG_HOOK_SCRIPT_PATH);
  expect(script.exists()).toBe(true);
  expect(script.asText()).toContain('sonar context __hook Claude');
  expect(script.asText()).not.toContain('ClaudePostToolUse');

  const settings = readClaudeSettings(harness, 'cwd');
  expect(claudeCagHookEntries(settings, 'PreToolUse')).toHaveLength(0);
  for (const eventType of CLAUDE_CAG_EVENT_TYPES) {
    const entries = claudeCagHookEntries(settings, eventType);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.matcher).toBe(CLAUDE_CAG_HOOK_MATCHER);
    expect(entries[0]?.hooks?.[0]?.type).toBe('command');
    expect(entries[0]?.hooks?.[0]?.command).toContain(CLAUDE_CAG_HOOK_MARKER);
    expect(entries[0]?.hooks?.[0]?.timeout).toBe(60);
  }
}

function expectClaudeCagHookAbsent(harness: TestHarness): void {
  for (const root of ['cwd', 'userHome'] as const) {
    expect(harness[root].file(CLAUDE_CAG_HOOK_SCRIPT_PATH).exists()).toBe(false);
    const settings = readClaudeSettings(harness, root);
    expect(claudeCagHookEntries(settings, 'PreToolUse')).toHaveLength(0);
    for (const eventType of CLAUDE_CAG_EVENT_TYPES) {
      expect(claudeCagHookEntries(settings, eventType)).toHaveLength(0);
    }
  }
}

function markHarnessCwdAsGitRoot(harness: TestHarness): void {
  harness.cwd.writeFile('.git/HEAD', 'ref: refs/heads/main\n');
}

const PROJECT_KEY = 'my-project';
const ORG_KEY = 'my-org';
const ORG_UUID = `${ORG_KEY}-uuid-v4`;
const TOKEN = 'cloud-token';
// Internal "dogfooding" tools are gated on an offline org allowlist in CAG; the
// CAG stub mirrors it (see tests/integration/resources/cag-stub.ts) so the
// rendered skill only contains the dogfooding tools section for an allowlisted
// organization.
const ALLOWLISTED_ORG = 'sonarsource';
const ALLOWLISTED_ORG_UUID = `${ALLOWLISTED_ORG}-uuid-v4`;
const DOGFOODING_SKILL_MARKER = '## Dogfooding Tools';
const CLAUDE_SKILL_PATH = '.claude/skills/sonar-context-augmentation/SKILL.md';
const COPILOT_SKILL_PATH = '.github/skills/sonar-context-augmentation/SKILL.md';
const CODEX_SKILL_PATH = '.agents/skills/sonar-context-augmentation/SKILL.md';
const CLAUDE_CAG_HOOK_MARKER = 'sonar-context-augmentation';
const CLAUDE_CAG_HOOK_MATCHER = 'Bash|PowerShell|Monitor|Read';
const CLAUDE_CAG_HOOK_SCRIPT_PATH = `.claude/hooks/sonar-context-augmentation/build-scripts/${hookScriptName('context-augmentation-hook')}`;
const CLAUDE_CAG_EVENT_TYPES = ['PostToolUse', 'PostToolUseFailure'] as const;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('integrate claude — Context Augmentation', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    markHarnessCwdAsGitRoot(harness);
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
        .withVortexEntitlement(ORG_KEY, ORG_UUID)
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
      const printSkill = findToolInvocation(invocations, 'print-skill');
      const integrate = findToolInvocation(invocations, 'integrate');
      expect(printSkill.argv).toEqual([
        'tool',
        'print-skill',
        '--invocation-prefix',
        'sonar context',
        '--sca-enabled=true',
      ]);
      expectPrintSkillContextEnv(printSkill);
      expect(integrate.argv).toEqual(['tool', 'integrate', '--invocation-prefix', 'sonar context']);
      expectContextEnv(integrate, serverUrl);
      // Both CAG spawns within one CLI run share the same SONAR_CONTEXT_INVOCATION_ID.
      expect(printSkill.env.SONAR_CONTEXT_INVOCATION_ID).toBe(
        integrate.env.SONAR_CONTEXT_INVOCATION_ID,
      );
      expect(result.stdout).not.toContain('Running: sonar-context-augmentation');
      expect(result.stdout).toContain(
        `✓  sonar-context-augmentation ${SONAR_CONTEXT_AUGMENTATION_VERSION}`,
      );
      expectSkillFile(harness, CLAUDE_SKILL_PATH, true);
      expectClaudeCagHookInstalled(harness);
      // A non-allowlisted org yields no dogfooding tools section in the rendered skill.
      expect(harness.cwd.file(CLAUDE_SKILL_PATH).asText()).not.toContain(DOGFOODING_SKILL_MARKER);

      // State records the declarative feature.
      const state = loadState(harness);
      expectRecordedCagFeature(state, {
        integrationId: CLAUDE_INTEGRATION_ID,
        projectRoot: harness.cwd.path,
        scaEnabled: true,
        serverUrl,
      });
    },
    { timeout: 30000 },
  );

  it(
    'does not duplicate the Claude Context Augmentation hook and preserves unrelated PostToolUse entries',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(PROJECT_KEY)
        .withVortexEntitlement(ORG_KEY, ORG_UUID)
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
      harness.cwd.writeFile(
        '.claude/settings.json',
        JSON.stringify({
          hooks: {
            PostToolUse: [
              {
                matcher: 'Bash',
                hooks: [{ type: 'command', command: 'echo user-hook', timeout: 15 }],
              },
            ],
          },
        }),
      );

      const env = {
        SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
        SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
      };
      expect(
        (await harness.run('integrate claude --non-interactive', { extraEnv: env })).exitCode,
      ).toBe(0);
      expect(
        (await harness.run('integrate claude --non-interactive', { extraEnv: env })).exitCode,
      ).toBe(0);

      const settings = readClaudeSettings(harness, 'cwd');
      expectClaudeCagHookInstalled(harness);
      expect(claudeCagHookEntries(settings, 'PreToolUse')).toHaveLength(0);
      expect(claudeCagPostToolEntries(settings)).toHaveLength(1);
      expect(claudeCagHookEntries(settings, 'PostToolUseFailure')).toHaveLength(1);
      expect(settings?.hooks?.PostToolUse?.some((entry) => entry.matcher === 'Bash')).toBe(true);
    },
    { timeout: 30000 },
  );

  it(
    'coexists with the Claude SQAA PostToolUse hook',
    async () => {
      const entitlementUuid = 'test-uuid-1234';
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(PROJECT_KEY)
        .withVortexEntitlement(ORG_KEY, entitlementUuid)
        .withScaEnabled(true)
        .start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, TOKEN, ORG_KEY);
      harness.state().withContextAugmentationBinaryInstalled();

      const result = await harness.run(
        `integrate claude --project ${PROJECT_KEY} --non-interactive`,
        {
          extraEnv: {
            SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
            SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
          },
        },
      );

      expect(result.exitCode).toBe(0);
      const settings = readClaudeSettings(harness, 'cwd');
      expectClaudeCagHookInstalled(harness);
      expect(claudeSqaaPostToolEntries(settings)).toHaveLength(1);
      expect(claudeSqaaPostToolEntries(settings)[0]?.matcher).toBe('Edit|Write');
      expect(claudeCagHookEntries(settings, 'PreToolUse')).toHaveLength(0);
      expect(claudeCagPostToolEntries(settings)).toHaveLength(1);
      expect(claudeCagHookEntries(settings, 'PostToolUseFailure')).toHaveLength(1);
    },
    { timeout: 30000 },
  );

  it(
    'renders internal dogfooding tools in the skill for an allowlisted organization',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(PROJECT_KEY)
        .withVortexEntitlement(ALLOWLISTED_ORG, ALLOWLISTED_ORG_UUID)
        .withScaEnabled(false)
        .start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, TOKEN, ALLOWLISTED_ORG);
      harness.state().withContextAugmentationBinaryInstalled();
      harness.cwd.writeFile(
        'sonar-project.properties',
        [
          `sonar.host.url=${serverUrl}`,
          `sonar.projectKey=${PROJECT_KEY}`,
          `sonar.organization=${ALLOWLISTED_ORG}`,
        ].join('\n'),
      );

      const result = await harness.run('integrate claude --non-interactive', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);
      // print-skill received the recorded (allowlisted) org, so the rendered
      // skill includes the internal dogfooding tools section.
      const printSkill = findToolInvocation(readInvocations(harness), 'print-skill');
      expect(printSkill.env.SONAR_CONTEXT_ORGANIZATION).toBe(ALLOWLISTED_ORG);
      expect(harness.cwd.file(CLAUDE_SKILL_PATH).asText()).toContain(DOGFOODING_SKILL_MARKER);
    },
    { timeout: 30000 },
  );

  it(
    'keys CAG state on the main working tree when integrate runs inside a linked worktree',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(PROJECT_KEY)
        .withVortexEntitlement(ORG_KEY, ORG_UUID)
        .withScaEnabled(true)
        .start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, TOKEN, ORG_KEY);
      harness.state().withContextAugmentationBinaryInstalled();

      // Main checkout = harness.cwd; add a linked worktree beside it and run
      // integrate from there.
      initGitRepo(harness.cwd.path);
      commitFile(harness.cwd.path, 'README.md', '# test\n');
      const worktreePath = join(dirname(harness.cwd.path), 'linked-worktree');
      git(['worktree', 'add', worktreePath, '-b', 'feature/x'], harness.cwd.path);
      writeFileSync(
        join(worktreePath, 'sonar-project.properties'),
        [
          `sonar.host.url=${serverUrl}`,
          `sonar.projectKey=${PROJECT_KEY}`,
          `sonar.organization=${ORG_KEY}`,
        ].join('\n'),
      );

      const integrateResult = await harness.run('integrate claude --non-interactive', {
        cwd: worktreePath,
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });
      expect(integrateResult.exitCode).toBe(0);

      // targetRoot stays the physical worktree (so teardown deletes the files it
      // wrote there); repoRoot records the stable main working tree, which is the
      // key `sonar context` matches against from any worktree. (The read side is
      // covered deterministically in the context passthrough spec — the harness
      // re-applies its state builder on every run, so an integrate-then-context
      // flow in one test cannot share state here.)
      const entry = findRecordedCagFeature(loadState(harness), CLAUDE_INTEGRATION_ID);
      expect(entry).toBeDefined();
      const targetRoot = entry?.feature.targetRoot ?? '';
      const repoRoot = entry?.feature.attrs?.repoRoot;
      expect(typeof repoRoot).toBe('string');
      // Compare full canonical paths (not just basenames): targetRoot resolves to
      // the physical worktree, repoRoot to the main working tree.
      expect(pathComparisonKey(targetRoot)).toBe(pathComparisonKey(worktreePath));
      expect(pathComparisonKey(repoRoot as string)).toBe(pathComparisonKey(harness.cwd.path));
      expect(repoRoot).not.toBe(targetRoot);
    },
    { timeout: 30000 },
  );

  it(
    'passes --sca-enabled=false to print-skill and warns when SCA enablement check fails',
    async () => {
      // No .withScaEnabled() call → fake server returns 404 for the SCA endpoint.
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(PROJECT_KEY)
        .withVortexEntitlement(ORG_KEY, ORG_UUID)
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
      const printSkill = findToolInvocation(readInvocations(harness), 'print-skill');
      const integrate = findToolInvocation(readInvocations(harness), 'integrate');
      expect(printSkill.argv).toContain('--sca-enabled=false');
      expect(integrate.argv).toEqual(['tool', 'integrate', '--invocation-prefix', 'sonar context']);
      expect(result.stderr).toContain('Could not verify SCA availability');
      expectSkillFile(harness, CLAUDE_SKILL_PATH, false);
      expectClaudeCagHookInstalled(harness);
      const state = loadState(harness);
      expectRecordedCagFeature(state, {
        integrationId: CLAUDE_INTEGRATION_ID,
        projectRoot: harness.cwd.path,
        scaEnabled: false,
        serverUrl,
      });
    },
    { timeout: 30000 },
  );

  it(
    'fails the install and does not write SKILL.md when print-skill produces empty output',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(PROJECT_KEY)
        .withVortexEntitlement(ORG_KEY, ORG_UUID)
        .withScaEnabled(true)
        .start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, TOKEN, ORG_KEY);
      harness.state().withContextAugmentationBinaryInstalled({ printSkillEmpty: true });
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

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(
        'sonar-context-augmentation tool print-skill produced empty output',
      );
      expect(harness.cwd.file(CLAUDE_SKILL_PATH).exists()).toBe(false);
      expectClaudeCagHookAbsent(harness);
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
      expect(harness.cwd.file(CLAUDE_SKILL_PATH).exists()).toBe(false);
      expectClaudeCagHookAbsent(harness);
      const state = loadState(harness);
      expect(findRecordedCagFeature(state)).toBeUndefined();
    },
    { timeout: 30000 },
  );

  it(
    'skips CAG with a warning when the org is not allowed to use it',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(PROJECT_KEY)
        .withVortexEntitlement(ORG_KEY, ORG_UUID, { allowed: false })
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
      expect(findRecordedCagFeature(state)).toBeUndefined();
      expect(harness.cwd.file(CLAUDE_SKILL_PATH).exists()).toBe(false);
      expectClaudeCagHookAbsent(harness);
      expect(result.stderr).toContain('not available for your organization');
    },
    { timeout: 30000 },
  );

  it(
    'installs CAG when the org is entitled but consumption limit is reached',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(PROJECT_KEY)
        .withVortexEntitlement(ORG_KEY, ORG_UUID, { allowed: false, hasEntitlement: true })
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
      expect(result.stderr).not.toContain('not available for your organization');
      const state = loadState(harness);
      expect(findRecordedCagFeature(state)).toBeDefined();
      expect(harness.cwd.file(CLAUDE_SKILL_PATH).exists()).toBe(true);
    },
    { timeout: 30000 },
  );

  it(
    'skips CAG with a warning when the entitlement check fails',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(PROJECT_KEY)
        .withCagEntitlementStatusCode(500)
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
      expect(findRecordedCagFeature(state)).toBeUndefined();
      expect(harness.cwd.file(CLAUDE_SKILL_PATH).exists()).toBe(false);
      expectClaudeCagHookAbsent(harness);
      expect(result.stderr).toContain('could not verify entitlement');
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
        .withVortexEntitlement(ORG_KEY, ORG_UUID)
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
      await harness.run('integrate claude --non-interactive', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      // The versioned binary must be on disk under <cliHome>/bin.
      const versionedName = buildLocalCagBinaryName(detectPlatform());
      expect(harness.cliHome.file('bin', versionedName).exists()).toBe(true);

      // state.json records the installation in the legacy tools section even
      // when the subsequent feature setup fails.
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
        .withVortexEntitlement(ORG_KEY, ORG_UUID)
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
    'surfaces indented CAG stdout/stderr when tool integrate fails',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(PROJECT_KEY)
        .withVortexEntitlement(ORG_KEY, ORG_UUID)
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

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain('  cag-stdout-diagnostic');
      expect(result.stderr).toContain('  cag-stderr-diagnostic');
      expect(result.stderr).toContain('Vortex context augmentation tool integration failed.');
    },
    { timeout: 30000 },
  );

  it(
    'does not record the declarative feature when CAG tool integrate fails',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(PROJECT_KEY)
        .withVortexEntitlement(ORG_KEY, ORG_UUID)
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

      expect(result.exitCode).toBe(1);
      const invocations = readInvocations(harness);
      const integrate = findToolInvocation(invocations, 'integrate');
      expect(integrate?.argv[1]).toBe('integrate');
      const state = loadState(harness);
      expect(findRecordedCagFeature(state)).toBeUndefined();
      expectSkillFile(harness, CLAUDE_SKILL_PATH, false);
      expectClaudeCagHookInstalled(harness);
      expect(result.stderr).toContain('Vortex context augmentation tool integration failed.');
    },
    { timeout: 30000 },
  );

  it(
    'skips CAG with a warning on SonarQube Cloud when no project key is configured',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withVortexEntitlement(ORG_KEY, ORG_UUID)
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
      expect(findRecordedCagFeature(state)).toBeUndefined();
      expect(harness.cwd.file(CLAUDE_SKILL_PATH).exists()).toBe(false);
      expectClaudeCagHookAbsent(harness);
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
      expect(harness.cwd.file(CLAUDE_SKILL_PATH).exists()).toBe(false);
      expectClaudeCagHookAbsent(harness);
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
    markHarnessCwdAsGitRoot(harness);
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
        .withVortexEntitlement(ORG_KEY, ORG_UUID)
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

      const result = await harness.run('integrate copilot --non-interactive', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);
      const invocations = readInvocations(harness);
      const printSkill = findToolInvocation(invocations, 'print-skill');
      const integrate = findToolInvocation(invocations, 'integrate');
      expect(printSkill.argv).toEqual([
        'tool',
        'print-skill',
        '--invocation-prefix',
        'sonar context',
        '--sca-enabled=false',
      ]);
      expectPrintSkillContextEnv(printSkill);
      expect(integrate.argv).toEqual(['tool', 'integrate', '--invocation-prefix', 'sonar context']);
      expectContextEnv(integrate, serverUrl);
      expect(result.stdout).not.toContain('Running: sonar-context-augmentation');
      expectSkillFile(harness, COPILOT_SKILL_PATH, false);
      expectClaudeCagHookAbsent(harness);

      // State records the declarative feature under the Copilot integration.
      const state = loadState(harness);
      expectRecordedCagFeature(state, {
        integrationId: COPILOT_INTEGRATION_ID,
        projectRoot: harness.cwd.path,
        scaEnabled: false,
        serverUrl,
      });
    },
    { timeout: 30000 },
  );
});

describe('integrate codex — Context Augmentation', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    markHarnessCwdAsGitRoot(harness);
    harness.state().withSecretsBinaryInstalled();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it(
    'invokes CAG with codex agent identifier',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(PROJECT_KEY)
        .withVortexEntitlement(ORG_KEY, ORG_UUID)
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

      const result = await harness.run('integrate codex --non-interactive', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);
      const invocations = readInvocations(harness);
      const printSkill = findToolInvocation(invocations, 'print-skill');
      const integrate = findToolInvocation(invocations, 'integrate');
      expect(printSkill.argv).toEqual([
        'tool',
        'print-skill',
        '--invocation-prefix',
        'sonar context',
        '--sca-enabled=false',
      ]);
      expectPrintSkillContextEnv(printSkill);
      expect(integrate.argv).toEqual(['tool', 'integrate', '--invocation-prefix', 'sonar context']);
      expectContextEnv(integrate, serverUrl);
      expect(result.stdout).not.toContain('Running: sonar-context-augmentation');
      expectSkillFile(harness, CODEX_SKILL_PATH, false);
      expectClaudeCagHookAbsent(harness);

      const state = loadState(harness);
      expectRecordedCagFeature(state, {
        integrationId: CODEX_INTEGRATION_ID,
        projectRoot: harness.cwd.path,
        scaEnabled: false,
        serverUrl,
      });
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
        .withVortexEntitlement(ORG_KEY, ORG_UUID)
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

      const result = await harness.run('integrate codex --non-interactive --skip-context', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);
      const nonProbe = readInvocations(harness).filter((i) => i.argv[0] !== '--version');
      expect(nonProbe).toEqual([]);
      const state = loadState(harness);
      expect(findRecordedCagFeature(state)).toBeUndefined();
      expect(harness.cwd.file(CODEX_SKILL_PATH).exists()).toBe(false);
    },
    { timeout: 30000 },
  );

  it(
    'skips CAG with a warning when the org is not allowed to use it',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withProject(PROJECT_KEY)
        .withVortexEntitlement(ORG_KEY, ORG_UUID, { allowed: false })
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

      const result = await harness.run('integrate codex --non-interactive', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);
      const nonProbe = readInvocations(harness).filter((i) => i.argv[0] !== '--version');
      expect(nonProbe).toEqual([]);
      expect(harness.cwd.file(CODEX_SKILL_PATH).exists()).toBe(false);
      expect(result.stderr).toContain('not available for your organization');
    },
    { timeout: 30000 },
  );

  it(
    'skips CAG with a warning on SonarQube Cloud when no project key is configured',
    async () => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withVortexEntitlement(ORG_KEY, ORG_UUID)
        .start();
      const serverUrl = server.baseUrl();
      harness.withAuth(serverUrl, TOKEN, ORG_KEY);
      harness.state().withContextAugmentationBinaryInstalled();
      // No sonar-project.properties — projectKey is undefined.

      const result = await harness.run('integrate codex --non-interactive', {
        extraEnv: {
          SONARQUBE_CLI_SONARCLOUD_URL: serverUrl,
          SONARQUBE_CLI_SONARCLOUD_API_URL: serverUrl,
        },
      });

      expect(result.exitCode).toBe(0);
      const nonProbe = readInvocations(harness).filter((i) => i.argv[0] !== '--version');
      expect(nonProbe).toEqual([]);
      expect(harness.cwd.file(CODEX_SKILL_PATH).exists()).toBe(false);
      expect(result.stderr).toContain('a project key and organization are required');
    },
    { timeout: 30000 },
  );
});

describe('integrate <agent> --global — Context Augmentation', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    markHarnessCwdAsGitRoot(harness);
    harness.state().withSecretsBinaryInstalled();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it.each([
    ['claude', 'integrate claude -g --non-interactive'],
    ['copilot', 'integrate copilot -g --non-interactive'],
    ['codex', 'integrate codex -g --non-interactive'],
  ])(
    'skips CAG entirely on "integrate %s --global" and warns when the org is entitled',
    async (_agent, command) => {
      const server = await harness
        .newFakeServer()
        .withAuthToken(TOKEN)
        .withVortexEntitlement(ORG_KEY, ORG_UUID)
        .start();
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
      expect(findRecordedCagFeature(state)).toBeUndefined();
      expect(harness.cwd.file(CLAUDE_SKILL_PATH).exists()).toBe(false);
      expect(harness.cwd.file(COPILOT_SKILL_PATH).exists()).toBe(false);
      expect(harness.cwd.file(CODEX_SKILL_PATH).exists()).toBe(false);
      expectClaudeCagHookAbsent(harness);
      expect(result.stderr).toContain(
        'Skipping Vortex context augmentation: not supported with --global',
      );
    },
    { timeout: 30000 },
  );

  it.each([
    ['claude', 'integrate claude -g --non-interactive'],
    ['copilot', 'integrate copilot -g --non-interactive'],
    ['codex', 'integrate codex -g --non-interactive'],
  ])(
    'skips CAG entirely on "integrate %s --global" without warning when the org is not entitled',
    async (_agent, command) => {
      // No CAG entitlement configured on the server.
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
      expect(findRecordedCagFeature(state)).toBeUndefined();
      expectClaudeCagHookAbsent(harness);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain(
        'Skipping Vortex context augmentation: not supported with --global',
      );
    },
    { timeout: 30000 },
  );
});
