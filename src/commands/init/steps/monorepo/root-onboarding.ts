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

import type { CompleteProjectMapping } from '@/core/project-discovery/project-discovery-result.ts';

import type { InitPathId } from '../../flow/step-ids.ts';
import { failed, type StepResult } from '../../flow/step-result.ts';
import type { InitRoot, InitStep, ProjectStepRef } from '../../flow/step-runner.ts';
import type { MonorepoRootResult } from '../../init-outcome.ts';
import type { DetectDeps } from '../detect.ts';
import type { LinkedProjectProblem } from '../linked-projects.ts';

/** Where a mapped root stands against the active connection, before anything runs for it. */
export type RootStatus =
  /** The directory is linked in `.sonar-config.json` and the remote has the project: nothing to do. */
  | { kind: 'configured' }
  /** The file links the directory, but the remote cannot confirm the project. Never created. */
  | { kind: 'unavailable'; problem: LinkedProjectProblem }
  /** `--root` names a key whose project exists in the active organization, but the file does not map it. */
  | { kind: 'existing' }
  /** No project has the mapped key yet. */
  | { kind: 'new' }
  | { kind: 'other-org' }
  /** `--root` names a key, but the file already maps that directory to another project. */
  | { kind: 'conflict'; recordedKey: string }
  /** The lookup failed for this root only. */
  | { kind: 'unchecked'; reason: string; cause: unknown };

export interface MonorepoRoot {
  mapping: CompleteProjectMapping;
  /** Relative to the repository root, for display and the summary. */
  path: string;
  root: InitRoot;
  /** Where `.sonar-config.json` sits; the same for every root of the run. */
  repositoryRoot: string;
  status: RootStatus;
  /** The git remote the keys were generated from, so a created project is named from the same input. */
  remote?: string;
  /** The key was guessed, not named by the user, so an existing project under it needs their say. */
  generated?: boolean;
}

/** How one root is onboarded: the step it takes, the path it is expected to take, and what runs it. */
export interface RootOnboarding extends InitStep<MonorepoRootResult> {
  readonly ref: ProjectStepRef;
  readonly target: MonorepoRoot;
  /** Its steps may still change it, as when a taken key's project is linked instead of created. */
  readonly initPath: InitPathId;
}

export function announceRoot({ path }: MonorepoRoot, { console, dryRun }: DetectDeps): void {
  console.print(`${dryRun ? 'Previewing' : 'Onboarding'} ${path}`);
}

/**
 * Nothing creates a project without binding, so a root left without one fails with how to map one.
 * `--bind` is suggested only when it could create the root's project.
 */
export function noProjectForRoot(path: string, bindable: boolean): StepResult<MonorepoRootResult> {
  const bind = bindable ? ', or use --bind' : '';
  return failed({
    path,
    kind: 'failed',
    reason: `No project was linked or created: creating one without repository binding is not supported. Name an existing project with --root ${path}=<project key>${bind}.`,
  });
}
