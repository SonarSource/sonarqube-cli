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

// Shared CAG (Context Augmentation) install + bootstrap step used by
// `sonar integrate claude` and `sonar integrate copilot`.
//
// All sub-steps are warn-on-failure: this function never throws. CAG is an
// optional companion to the existing MCP/secrets setup, so a CAG failure must
// not regress the existing user-facing behavior.

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

import { version as VERSION } from '../../../../../package.json';
import type { ResolvedAuth } from '../../../../lib/auth-resolver';
import { SONAR_CONTEXT_AUGMENTATION_VERSION } from '../../../../lib/signatures';
import { loadState, saveState, upsertAgentExtension } from '../../../../lib/state-manager';
import { blank, info, success, text, warn } from '../../../../ui';
import { installContextAugmentationBinary } from '../../_common/install/context-augmentation';

export type ContextAugmentationAgent = 'claude-code' | 'copilot';

export interface SetupContextAugmentationParams {
  auth: ResolvedAuth;
  agent: ContextAugmentationAgent;
  projectRoot: string;
  projectKey: string | undefined;
  isGlobal: boolean;
}

const SKILL_INVOCATION_PREFIX = 'sonar context';

export async function setupContextAugmentation(p: SetupContextAugmentationParams): Promise<void> {
  blank();
  info('Setting up SonarQube Context Augmentation...');

  if (!p.projectKey || !p.auth.orgKey) {
    warn(
      'Skipping Context Augmentation: a project key and organization are required (configure your project or pass --project).',
    );
    return;
  }

  let binaryPath: string;
  try {
    binaryPath = await installContextAugmentationBinary();
  } catch (err) {
    warn(`Failed to install sonar-context-augmentation: ${(err as Error).message}`);
    return;
  }

  const initOk = await runCagSubprocess(
    binaryPath,
    [
      'init',
      '--org',
      p.auth.orgKey,
      '--project-key',
      p.projectKey,
      // We install the skill ourselves below with --invocation-prefix overridden,
      // so suppress init's default skill install (CAG-374).
      '--skip-skill-install',
    ],
    p,
  );
  if (!initOk) {
    warn('Context Augmentation init failed (see output above). Skipping skill installation.');
    return;
  }

  const skillOk = await runCagSubprocess(
    binaryPath,
    ['skill', '--install', p.agent, '--invocation-prefix', SKILL_INVOCATION_PREFIX],
    p,
  );
  if (!skillOk) {
    warn('Context Augmentation skill install failed (see output above).');
    return;
  }

  recordSkillExtension(p);
  success('SonarQube Context Augmentation configured');
}

async function runCagSubprocess(
  binaryPath: string,
  args: string[],
  p: SetupContextAugmentationParams,
): Promise<boolean> {
  text(`  Running: sonar-context-augmentation ${args.join(' ')}`);
  return new Promise<boolean>((resolve) => {
    let child;
    try {
      child = spawn(binaryPath, args, {
        cwd: p.projectRoot,
        stdio: 'inherit',
        env: { ...process.env, SONAR_TOKEN: p.auth.token },
      });
    } catch (err) {
      // Some platforms (notably Windows when the binary is not a valid PE)
      // surface spawn failures synchronously rather than via the 'error' event.
      // Preserve the warn-on-failure contract by handling both shapes.
      warn(`sonar-context-augmentation failed to start: ${(err as Error).message}`);
      resolve(false);
      return;
    }
    child.on('error', (err) => {
      warn(`sonar-context-augmentation failed to start: ${err.message}`);
      resolve(false);
    });
    child.on('exit', (code) => {
      resolve(code === 0);
    });
  });
}

function recordSkillExtension(p: SetupContextAugmentationParams): void {
  try {
    const state = loadState();
    upsertAgentExtension(state, {
      id: randomUUID(),
      agentId: p.agent,
      projectRoot: p.isGlobal ? homedir() : p.projectRoot,
      global: p.isGlobal,
      projectKey: p.projectKey,
      orgKey: p.auth.orgKey,
      serverUrl: p.auth.serverUrl,
      updatedByCliVersion: VERSION,
      updatedAt: new Date().toISOString(),
      kind: 'skill',
      name: 'sonar-context-augmentation',
      version: SONAR_CONTEXT_AUGMENTATION_VERSION,
    });
    saveState(state);
  } catch (err) {
    warn(`Failed to record Context Augmentation skill in state: ${(err as Error).message}`);
  }
}
