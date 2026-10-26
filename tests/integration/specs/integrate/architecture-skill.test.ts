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

import { statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  ARCHITECTURE_SKILL,
  ARCHITECTURE_SKILL_MARKER,
} from '@/commands/architecture/skill-content.ts';
import { ARCHITECTURE_SKILL_FEATURE_ID } from '@/commands/integrate/_common/features/architecture-skill-feature.ts';
import { resolveDevinConfigDir } from '@/core/host/environment/devin-config-dir.ts';
import type { CliState } from '@/core/state/state.ts';

import { POST_UPDATE_TRIGGER_COMMAND } from '../../../_common/isolated-cli-env.js';
import { TestHarness } from '../../harness';
import { buildHomeEnv } from '../../harness/platform';
import { chooseCustomize } from './integrate-test-helpers';
import { findInstalledFeature } from './state-helpers';

const AGENTS = [
  ['claude', 'claude-code', '.claude/skills'],
  ['codex', 'codex', '.agents/skills'],
  ['cursor', 'cursor', '.cursor/skills'],
  ['copilot', 'copilot-cli', '.copilot/skills'],
  ['antigravity', 'antigravity', '.gemini/config/skills'],
  ['opencode', 'opencode', '.config/opencode/skills'],
  ['pi', 'pi', '.pi/agent/skills'],
  ['devin', 'devin', ''],
] as const;

function skillPath(harness: TestHarness, agent: string, directory: string): string {
  return join(
    agent === 'devin'
      ? relative(
          harness.userHome.path,
          resolveDevinConfigDir(harness.userHome.path, buildHomeEnv(harness.userHome.path)),
        )
      : directory,
    ...(agent === 'devin' ? ['skills'] : []),
    'sonar-architecture',
    'SKILL.md',
  );
}

describe('managed architecture skill', () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await TestHarness.create();
    await harness.newFakeBinariesServer().start();
    const server = await harness.newFakeServer().withAuthToken('test-token').start();
    harness.withAuth(server.baseUrl(), 'test-token');
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it.each(AGENTS)(
    'installs, records and resets the skill through integrate %s',
    async (agent, integrationId, directory) => {
      const result = await harness.run(`integrate ${agent} --non-interactive`);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('architecture skill');
      const path = skillPath(harness, agent, directory);
      expect(harness.userHome.file(path).asText()).toBe(ARCHITECTURE_SKILL);
      expect(ARCHITECTURE_SKILL).not.toContain('SONARQUBE_CLI_ALPHA');
      expect(
        findInstalledFeature(harness, integrationId, ARCHITECTURE_SKILL_FEATURE_ID, 'global'),
      ).toBeDefined();
      if (agent === 'devin') {
        expect(harness.userHome.file(join(path, '..', '..', '..', 'AGENTS.md')).asText()).toContain(
          JSON.stringify(join(harness.userHome.path, path)),
        );
      }
      harness.state().withRawState(harness.stateJsonFile.asText());
      const before = statSync(harness.userHome.file(path).path).mtimeMs;
      expect((await harness.run(`integrate ${agent} --non-interactive`)).exitCode).toBe(0);
      expect(statSync(harness.userHome.file(path).path).mtimeMs).toBe(before);
      harness.state().withRawState(harness.stateJsonFile.asText());
      expect((await harness.run('system reset --force')).exitCode).toBe(0);
      expect(harness.userHome.exists(path)).toBe(false);
    },
    { timeout: 30000 },
  );

  it(
    'protects an existing unmanaged skill',
    async () => {
      const path = '.claude/skills/sonar-architecture/SKILL.md';
      harness.userHome.writeFile(path, '# My architecture skill');
      const result = await harness.run('integrate claude --non-interactive');
      expect(result.exitCode).not.toBe(0);
      expect(harness.userHome.file(path).asText()).toBe('# My architecture skill');
      expect(
        findInstalledFeature(harness, 'claude-code', ARCHITECTURE_SKILL_FEATURE_ID),
      ).toBeUndefined();
    },
    { timeout: 30000 },
  );

  it(
    'refreshes existing Alpha copies without overwriting unrelated content',
    async () => {
      const legacy = '.agents/skills/sonar-architecture/SKILL.md';
      const custom = '.claude/skills/sonar-architecture/SKILL.md';
      harness.userHome.writeFile(legacy, `${ARCHITECTURE_SKILL_MARKER}\nOld Alpha instructions`);
      harness.userHome.writeFile(custom, '# My own skill');
      expect((await harness.run('integrate cursor --non-interactive')).exitCode).toBe(0);
      expect(harness.userHome.file(legacy).asText()).toBe(ARCHITECTURE_SKILL);
      expect(harness.userHome.file(custom).asText()).toBe('# My own skill');
    },
    { timeout: 30000 },
  );

  it(
    'refreshes home-level Alpha copies when integrating Antigravity',
    async () => {
      const path = '.agents/skills/sonar-architecture/SKILL.md';
      harness.userHome.writeFile(path, `${ARCHITECTURE_SKILL_MARKER}\nOld Alpha instructions`);
      expect((await harness.run('integrate antigravity --non-interactive')).exitCode).toBe(0);
      expect(harness.userHome.file(path).asText()).toBe(ARCHITECTURE_SKILL);
    },
    { timeout: 30000 },
  );

  it(
    'records and removes the native skill even when a legacy copy is unreadable',
    async () => {
      harness.userHome.writeFile(
        '.claude/skills/sonar-architecture/SKILL.md/keep.txt',
        'unrelated content',
      );
      const result = await harness.run('integrate cursor --non-interactive');
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain('Could not refresh a previous architecture skill');
      expect(findInstalledFeature(harness, 'cursor', ARCHITECTURE_SKILL_FEATURE_ID)).toBeDefined();
      harness.state().withRawState(harness.stateJsonFile.asText());
      expect((await harness.run('system reset --force')).exitCode).toBe(0);
      expect(harness.userHome.exists('.cursor/skills/sonar-architecture/SKILL.md')).toBe(false);
      expect(
        harness.userHome.file('.claude/skills/sonar-architecture/SKILL.md/keep.txt').asText(),
      ).toBe('unrelated content');
    },
    { timeout: 30000 },
  );

  it(
    'refreshes a recorded skill after a CLI update',
    async () => {
      expect((await harness.run('integrate claude --non-interactive')).exitCode).toBe(0);
      const path = '.claude/skills/sonar-architecture/SKILL.md';
      harness.userHome.writeFile(path, `${ARCHITECTURE_SKILL_MARKER}\nOld instructions`);
      const state = harness.stateJsonFile.asJson() as CliState;
      state.config.cliVersion = '0.5.0';
      harness.state().withRawState(JSON.stringify(state));
      expect((await harness.run(POST_UPDATE_TRIGGER_COMMAND)).exitCode).toBe(0);
      expect(harness.userHome.file(path).asText()).toBe(ARCHITECTURE_SKILL);
    },
    { timeout: 30000 },
  );

  it(
    'can decline the skill through Customize',
    async () => {
      const session = harness.runInteractive('integrate claude');
      await chooseCustomize(session);
      await session.decline('Install architecture skill?');
      await session.accept('Install secret scanning hooks?');
      await session.accept('Install MCP server?');
      expect((await session.waitFinish()).exitCode).toBe(0);
      expect(harness.userHome.exists('.claude/skills/sonar-architecture/SKILL.md')).toBe(false);
      expect(
        findInstalledFeature(harness, 'claude-code', ARCHITECTURE_SKILL_FEATURE_ID),
      ).toBeUndefined();
    },
    { timeout: 30000 },
  );
});
