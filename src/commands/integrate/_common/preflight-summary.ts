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

// Preflight summary shown at the start of the git integrate command, before install.

import { GitRepo } from '@/core/host/git/hooks.ts';
import { type Console, phaseItem } from '@/core/ui/console.ts';

export async function printGitPreflightSummary(gitRoot: string, console: Console): Promise<void> {
  const gitRepo = new GitRepo(gitRoot);
  const hooksDir = await gitRepo.getHooksDir();
  const framework = await resolveGitFrameworkLabel(gitRepo);

  console.phase('Repository', [
    phaseItem('Root', 'done', gitRoot),
    phaseItem('Git repository', 'done', 'detected'),
    phaseItem('Hooks directory', 'done', hooksDir),
    phaseItem('Framework', 'info', framework),
  ]);
}

async function resolveGitFrameworkLabel(gitRepo: GitRepo): Promise<string> {
  if (gitRepo.usesPreCommitFramework()) {
    return 'pre-commit';
  }
  if (await gitRepo.usesHusky()) {
    return 'husky';
  }
  return 'native git hooks';
}
