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

import { failed, skipped, type StepResult, success } from '../../flow/step-result.ts';
import type { ProjectStepRef } from '../../flow/step-runner.ts';
import type { MonorepoRootResult } from '../../init-outcome.ts';
import type { DetectDeps } from '../detect.ts';
import { ExistingProjectLinker } from '../link-existing.ts';
import {
  announceRoot,
  type MonorepoRoot,
  noProjectForRoot,
  type RootOnboarding,
} from './root-onboarding.ts';

/**
 * The key generated for a root names an existing project: it is offered for linking, as for one
 * directory, without `--bind`, which refuses to touch a project that already exists.
 */
export class OfferExistingRoot implements RootOnboarding {
  readonly initPath = 'link_existing';
  private readonly linker: ExistingProjectLinker;

  constructor(
    readonly target: MonorepoRoot,
    private readonly deps: DetectDeps,
  ) {
    const { mapping, remote } = target;
    this.linker = new ExistingProjectLinker(
      {
        path: 'link-existing',
        projectRoot: mapping.projectRoot,
        remote,
        projectKey: mapping.projectKey,
      },
      { ...deps, intent: undefined },
    );
  }

  get ref(): ProjectStepRef {
    return { step: 'link', root: this.target.root };
  }

  async run(): Promise<StepResult<MonorepoRootResult>> {
    announceRoot(this.target, this.deps);
    const outcome = await this.linker.link();
    const { path, mapping } = this.target;
    if (outcome.kind === 'linked') {
      return success(
        { path, kind: 'linked', projectKey: outcome.projectKey },
        { projectKey: outcome.projectKey, initPath: 'link_existing' },
      );
    }
    if (outcome.kind === 'dry-run') {
      return skipped({ path, kind: 'would-link', projectKey: mapping.projectKey });
    }
    if (this.deps.intent?.kind === 'bind') {
      return failed({
        path,
        kind: 'failed',
        reason: `Project '${mapping.projectKey}' already exists and was not linked. Name it with --root ${path}=<project key> to map it.`,
      });
    }
    // The project exists, which `--bind` refuses to touch.
    return noProjectForRoot(path, false);
  }
}
