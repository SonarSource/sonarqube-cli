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

// Shared CAG test helpers: the invocation log written by the CAG stub
// (resources/cag-stub.ts), and the on-disk shape of the session-start hook
// the Vortex Context subfeature installs.

import { basename, join } from 'node:path';

import { expect } from 'bun:test';

import type { SessionStartAgent } from '@/commands/hook/agent-session-start/types.ts';
import {
  SESSION_START_SCRIPT_REL,
  VORTEX_HOOK_MARKER,
} from '@/commands/integrate/_common/features/context-augmentation-feature.ts';
import { HOOKS_DIR } from '@/commands/integrate/_common/hooks.ts';
import type { IntegrationScope } from '@/core/state/state.ts';

import type { Dir } from './dir';
import type { File } from './file';
import type { TestHarness } from './index';
import { IS_WINDOWS, SCRIPT_EXT } from './platform';

// ---------------------------------------------------------------------------
// CAG invocation log
// ---------------------------------------------------------------------------

export interface CagInvocation {
  argv: string[];
  env: {
    SONAR_CONTEXT_ORGANIZATION?: string;
    SONAR_CONTEXT_PROJECT?: string;
    SONAR_CONTEXT_TOKEN?: string;
    SONAR_CONTEXT_URL?: string;
    SONAR_CONTEXT_INVOCATION_ID?: string;
    SONAR_CONTEXT_WORKSPACE_ROOT?: string;
  };
}

export function readCagInvocations(harness: TestHarness): CagInvocation[] {
  const file = harness.cliHome.file('cag-invocations.jsonl');
  if (!file.exists()) return [];
  return file
    .asText()
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CagInvocation);
}

// ---------------------------------------------------------------------------
// Session-start hook
// ---------------------------------------------------------------------------

const SESSION_START_SCRIPT_NAME = basename(SESSION_START_SCRIPT_REL);

interface VortexHookInstallShape {
  configDir: string;
  hookConfigPath: string[];
  /** Only for agents whose global layout differs from their project one. */
  globalConfigDir?: string;
  globalHookConfigPath?: string[];
  expectHookEntries: (config: any) => void;
}

const VORTEX_HOOK_INSTALL_SHAPES: Record<SessionStartAgent, VortexHookInstallShape> = {
  claude: {
    configDir: '.claude',
    hookConfigPath: ['.claude', 'settings.json'],
    expectHookEntries: ({ hooks }) => {
      expect(hooks.SessionStart).toHaveLength(1);
      expect(hooks.SessionStart[0].matcher).toBe('startup|clear');
      expect(hooks.SessionStart[0].hooks[0].command).toContain(SESSION_START_SCRIPT_NAME);
      expect(hooks.SubagentStart).toHaveLength(1);
      expect(hooks.SubagentStart[0].matcher).toBeUndefined();
      expect(hooks.SubagentStart[0].hooks[0].command).toContain(SESSION_START_SCRIPT_NAME);
    },
  },
  codex: {
    configDir: '.codex',
    hookConfigPath: ['.codex', 'hooks.json'],
    expectHookEntries: ({ hooks }) => {
      expect(hooks.SessionStart).toHaveLength(1);
      expect(hooks.SessionStart[0].matcher).toBe('startup|clear');
      expect(hooks.SessionStart[0].hooks[0].command).toContain(SESSION_START_SCRIPT_NAME);
      expect(hooks.SessionStart[0].hooks[0].additionalContextLimit).toBe(5000);
      expect(hooks.SubagentStart).toHaveLength(1);
      expect(hooks.SubagentStart[0].matcher).toBeUndefined();
      expect(hooks.SubagentStart[0].hooks[0].command).toContain(SESSION_START_SCRIPT_NAME);
      expect(hooks.SubagentStart[0].hooks[0].additionalContextLimit).toBe(5000);
    },
  },
  copilot: {
    configDir: '.github',
    hookConfigPath: ['.github', 'hooks', 'hooks.json'],
    globalConfigDir: '.copilot',
    globalHookConfigPath: ['.copilot', 'hooks', 'hooks.json'],
    expectHookEntries: ({ hooks }) => {
      const commandKey = IS_WINDOWS ? 'powershell' : 'bash';
      expect(hooks.sessionStart).toHaveLength(1);
      expect(hooks.sessionStart[0].type).toBe('command');
      expect(hooks.sessionStart[0].timeoutSec).toBe(60);
      expect(hooks.sessionStart[0][commandKey]).toContain(SESSION_START_SCRIPT_NAME);
      expect(hooks.subagentStart).toHaveLength(1);
      expect(hooks.subagentStart[0].type).toBe('command');
      expect(hooks.subagentStart[0].timeoutSec).toBe(60);
      expect(hooks.subagentStart[0][commandKey]).toContain(SESSION_START_SCRIPT_NAME);
    },
  },
  cursor: {
    configDir: '.cursor',
    hookConfigPath: ['.cursor', 'hooks.json'],
    expectHookEntries: ({ hooks }) => {
      expect(hooks.sessionStart).toHaveLength(1);
      expect(hooks.sessionStart[0].command).toContain(SESSION_START_SCRIPT_NAME);
      expect(hooks.sessionStart[0].matcher).toBeUndefined();
      expect(hooks.subagentStart).toBeUndefined();
    },
  },
};

export function sessionStartScript(
  root: Dir,
  agent: SessionStartAgent,
  scope: IntegrationScope = 'project',
): File {
  const shape = VORTEX_HOOK_INSTALL_SHAPES[agent];
  const configDir = (scope === 'global' ? shape.globalConfigDir : undefined) ?? shape.configDir;
  return root.file(join(configDir, HOOKS_DIR, `${SESSION_START_SCRIPT_REL}${SCRIPT_EXT}`));
}

function hookConfigText(
  root: Dir,
  agent: SessionStartAgent,
  scope: IntegrationScope = 'project',
): string {
  const shape = VORTEX_HOOK_INSTALL_SHAPES[agent];
  const path =
    (scope === 'global' ? shape.globalHookConfigPath : undefined) ?? shape.hookConfigPath;
  const config = root.file(...path);
  return config.exists() ? config.asText() : '';
}

export function isVortexHookInstalled(root: Dir, agent: SessionStartAgent): boolean {
  return (
    sessionStartScript(root, agent).exists() &&
    hookConfigText(root, agent).includes(VORTEX_HOOK_MARKER)
  );
}

export function expectVortexHookInstalled(
  root: Dir,
  agent: SessionStartAgent,
  scope: IntegrationScope = 'project',
): void {
  const script = sessionStartScript(root, agent, scope);
  expect(script.exists()).toBe(true);
  expect(script.isExecutable).toBe(true);
  expect(script.asText()).toContain(`sonar hook agent-session-start --agent ${agent}`);

  const config = hookConfigText(root, agent, scope);
  expect(config).not.toBe('');
  VORTEX_HOOK_INSTALL_SHAPES[agent].expectHookEntries(JSON.parse(config));
}

export function expectVortexHookAbsent(
  root: Dir,
  agent: SessionStartAgent,
  scope: IntegrationScope = 'project',
): void {
  expect(sessionStartScript(root, agent, scope).exists()).toBe(false);
  expect(hookConfigText(root, agent, scope)).not.toContain(VORTEX_HOOK_MARKER);
}
