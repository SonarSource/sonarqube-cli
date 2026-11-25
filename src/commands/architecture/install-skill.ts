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

// `sonar architecture install-skill`: writes the architecture skill where Claude Code
// (`.claude/skills`) and Cursor (`.agents/skills`) discover it, with the same overwrite
// guard as `sonar integrate`. Not recorded as an integration, so `system reset` keeps it.

import { homedir } from 'node:os';
import { join } from 'node:path';

import type { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import type { IntegrationContext } from '@/core/framework/features/types.ts';
import { readTextFile } from '@/core/framework/resources/common.ts';
import { textSnippetRemover } from '@/core/framework/resources/text-snippet.ts';
import { wholeFile } from '@/core/framework/resources/whole-file.ts';
import { findGitRoot } from '@/core/host/git/discover.ts';
import { loadState } from '@/core/state/state-repository.ts';

import { sonarBeginMarker, sonarEndMarker } from '../integrate/_common/instructions-templates.ts';
import { ARCHITECTURE_SKILL, ARCHITECTURE_SKILL_MARKER } from './skill-content.ts';

const SKILL_DIRS = [
  ['.claude', 'skills'],
  ['.agents', 'skills'],
];
/** Files where CLI 1.13 wrote a marked "Architecture while coding" block. */
const INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md'];
/** The id of that block's markers, kept so this command can remove it. */
const CODING_BLOCK_ID = 'sonarqube-architecture-coding';

export interface InstallSkillOptions {
  global?: boolean;
  force?: boolean;
}

export async function installSkill(
  options: InstallSkillOptions,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  const global = options.global === true;
  const targetRoot = global ? homedir() : projectRoot();
  const context: IntegrationContext = {
    state: loadState(),
    targetRoot,
    scope: global ? 'global' : 'project',
    executionMode: 'install',
    console: ctx.console,
    force: options.force === true,
    resolvedDependencies: new Map(),
  };

  await SKILL_DIRS.reduce(
    (previous, dir) =>
      previous.then(() =>
        installAt(join(targetRoot, ...dir, 'sonar-architecture', 'SKILL.md'), context),
      ),
    Promise.resolve(),
  );
  if (global) return;
  await INSTRUCTION_FILES.reduce(
    (previous, file) => previous.then(() => removeCodingBlock(join(targetRoot, file), context)),
    Promise.resolve(),
  );
}

async function installAt(path: string, context: IntegrationContext): Promise<void> {
  const skill = wholeFile({
    id: 'sonar-architecture-skill',
    displayName: 'architecture skill',
    targetPath: path,
    content: ARCHITECTURE_SKILL,
    requiresForce: true,
    managedMarker: ARCHITECTURE_SKILL_MARKER,
    overwriteRemediationHint: 'Run again with --force to replace it.',
  });
  if (await skill.isApplied(context)) {
    context.console.print(`Already up to date: ${path}`);
    return;
  }
  await skill.apply(context);
  context.console.print(`Installed ${path}`);
}

/** The skill is the whole installation, so a block an earlier version wrote is removed; the rest of the file is kept. */
async function removeCodingBlock(path: string, context: IntegrationContext): Promise<void> {
  const startMarker = sonarBeginMarker(CODING_BLOCK_ID);
  if (!(await readTextFile(path))?.includes(startMarker)) return;
  await textSnippetRemover({
    id: CODING_BLOCK_ID,
    targetPath: path,
    startMarker,
    endMarker: sonarEndMarker(CODING_BLOCK_ID),
  }).remove(context);
  context.console.print(`Removed the architecture coding block from ${path}`);
}

function projectRoot(): string {
  const { gitRoot, isGit } = findGitRoot(process.cwd());
  return isGit ? gitRoot : process.cwd();
}
