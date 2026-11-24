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

import { skipped, type StepResult, success } from '../../flow/step-result.ts';
import type { ProjectStepRef } from '../../flow/step-runner.ts';
import type { MonorepoRootResult } from '../../init-outcome.ts';
import type { DetectDeps } from '../detect.ts';
import { writeMapping } from '../mapping.ts';
import { announceRoot, type MonorepoRoot, type RootOnboarding } from './root-onboarding.ts';

/** An existing project under a key the user named, or any key under `--link`: the root is mapped to it. */
export class MapExistingRoot implements RootOnboarding {
  readonly initPath = 'link_existing';

  constructor(
    readonly target: MonorepoRoot,
    private readonly deps: DetectDeps,
  ) {}

  get ref(): ProjectStepRef {
    return { step: 'link', root: this.target.root };
  }

  async run(): Promise<StepResult<MonorepoRootResult>> {
    const { mapping, path } = this.target;
    const { auth, console, dryRun } = this.deps;
    announceRoot(this.target, this.deps);
    if (dryRun) {
      return skipped({ path, kind: 'would-link', projectKey: mapping.projectKey });
    }
    await writeMapping(auth, mapping.projectKey, mapping.projectRoot, console, 'found', true);
    console.success(`Mapped ${path} to project '${mapping.projectKey}'.`);
    return success(
      { path, kind: 'linked', projectKey: mapping.projectKey },
      { projectKey: mapping.projectKey },
    );
  }
}
