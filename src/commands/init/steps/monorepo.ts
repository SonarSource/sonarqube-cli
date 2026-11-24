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

import { findGitRoot, getGitRemote } from '@/core/host/git/discover.ts';
import { stripGitRemoteUrlUserinfo } from '@/core/server/git-remote-url.ts';

import type { InitOutcome, MonorepoRootResult } from '../init-outcome.ts';
import { generateProjectProposal } from '../key-proposal.ts';
import type { MonorepoRootOption } from '../options.ts';
import type { DetectDeps } from './detect.ts';
import { CreateRoot } from './monorepo/create-root.ts';
import { DetectRootsStep } from './monorepo/detect-roots-step.ts';
import { IsolatedRootStep } from './monorepo/isolated-root.ts';
import type { RootOnboarding } from './monorepo/root-onboarding.ts';
import { type BindableRoot, bindNewRoots } from './monorepo-bind.ts';

/**
 * Reports the project roots that `.sonar-config.json` maps as configured, and onboards the ones named
 * with `--root`, each on its own path. The mapped roots that were not named are reported too, so a
 * run always shows every root the file maps. A root's mapping is merged into the file as soon as that root
 * completes, so what finished stays in place when a later root fails or the run stops, and a rerun
 * skips it. The roots run one after the other because each may prompt.
 */
export async function runMonorepo(
  projectRoot: string,
  deps: DetectDeps,
  explicitRoots: readonly MonorepoRootOption[] = [],
  linkOnly = false,
): Promise<InitOutcome> {
  const detected = await deps.steps.run(
    new DetectRootsStep(projectRoot, deps, explicitRoots, linkOnly),
  );
  if (!detected) {
    return { kind: 'no-monorepo-roots' };
  }
  const planned = detected.map(({ target }) => target);
  const bound = await bindNewRootsTogether(planned, deps);
  return { kind: 'monorepo', roots: await onboardInOrder(planned, bound, deps) };
}

/**
 * The roots that need a new project are bound to the repository in one call, asked once, before
 * any root runs. A root left out of it (the user declined, or the repository cannot be bound) fails
 * afterwards with how to map an existing project instead.
 */
async function bindNewRootsTogether(
  roots: readonly RootOnboarding[],
  deps: DetectDeps,
): Promise<ReadonlyMap<string, MonorepoRootResult>> {
  // `--link` never creates a project, and binding is a way of creating one: its roots are never planned for creation.
  const newRoots = roots.filter((root) => root instanceof CreateRoot).map(({ target }) => target);
  if (newRoots.length === 0) {
    return new Map();
  }
  const { gitRoot, isGit } = findGitRoot(newRoots[0].repositoryRoot);
  const rawRemote = isGit ? await getGitRemote(gitRoot) : '';
  const remote = rawRemote ? stripGitRemoteUrlUserinfo(rawRemote) : undefined;
  const bindable = newRoots.map(({ root, path, mapping }): BindableRoot => ({
    root,
    path,
    projectRoot: mapping.projectRoot,
    projectKey: mapping.projectKey,
    projectName: generateProjectProposal(mapping.projectRoot, remote, deps.auth.orgKey).projectName,
  }));
  const results = (await bindNewRoots(bindable, remote, deps)) ?? [];
  return new Map(results.map((result) => [result.path, result]));
}

/** One root finishes, prompts included, before the next starts; a root the batch bound has finished already. */
function onboardInOrder(
  roots: readonly RootOnboarding[],
  bound: ReadonlyMap<string, MonorepoRootResult>,
  deps: DetectDeps,
): Promise<MonorepoRootResult[]> {
  return roots.reduce<Promise<MonorepoRootResult[]>>(async (previous, root) => {
    const done = await previous;
    done.push(bound.get(root.target.path) ?? (await deps.steps.run(new IsolatedRootStep(root))));
    return done;
  }, Promise.resolve([]));
}
