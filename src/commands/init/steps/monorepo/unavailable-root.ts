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

import { failed, type StepResult } from '../../flow/step-result.ts';
import type { ProjectStepRef } from '../../flow/step-runner.ts';
import type { MonorepoRootResult } from '../../init-outcome.ts';
import type { LinkedProjectProblem } from '../linked-projects.ts';
import type { MonorepoRoot, RootOnboarding } from './root-onboarding.ts';

/** The file links the root, but the remote cannot confirm its project; nothing is created for it. */
export class UnavailableRoot implements RootOnboarding {
  readonly initPath = 'already_done';

  constructor(
    readonly target: MonorepoRoot,
    private readonly problem: LinkedProjectProblem,
  ) {}

  get ref(): ProjectStepRef {
    return { step: 'link', root: this.target.root };
  }

  run(): Promise<StepResult<MonorepoRootResult>> {
    const { path, mapping } = this.target;
    return Promise.resolve(
      failed({ path, kind: 'unavailable', projectKey: mapping.projectKey, problem: this.problem }),
    );
  }
}
