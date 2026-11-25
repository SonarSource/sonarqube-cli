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

import { relativeProjectPath } from '@/core/project-discovery/link-target.ts';

import { alreadyDone, type StepResult } from '../flow/step-result.ts';
import type { InitStep, StepRef } from '../flow/step-runner.ts';
import type { InitOutcome, InitPath } from '../init-outcome.ts';
import type { DetectDeps } from './detect.ts';
import { findLinkedProjectIssues, isUnavailable } from './linked-projects.ts';

type CompletePath = Extract<InitPath, { path: 'complete' }>;
type CompleteOutcome = Extract<InitOutcome, { kind: 'complete' }>;

/** The file says the directory is set up; the remote may disagree, which is reported but never repaired. */
export class CompleteLinkStep implements InitStep<InitOutcome> {
  readonly ref: StepRef;
  readonly initPath = 'already_done';

  constructor(
    private readonly path: CompletePath,
    private readonly deps: DetectDeps,
  ) {
    this.ref = { step: 'link', root: deps.root };
  }

  async run(): Promise<StepResult<InitOutcome>> {
    const outcome = await this.check();
    return alreadyDone(outcome, { projectKey: outcome.projectKeys[0] });
  }

  private async check(): Promise<CompleteOutcome> {
    const { projectRoot, projects } = this.path;
    const { deps } = this;

    const issues = await findLinkedProjectIssues(
      projects.map((project) => ({
        projectKey: project.projectKey,
        path: relativeProjectPath(projectRoot, project.projectRoot),
      })),
      deps,
    );
    const unavailable = new Set(issues.filter(isUnavailable).map(({ projectKey }) => projectKey));
    const projectKeys = projects
      .map(({ projectKey }) => projectKey)
      .filter((projectKey) => !unavailable.has(projectKey));
    return { kind: 'complete', projectKeys, issues };
  }
}
