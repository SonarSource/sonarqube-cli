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

import type { StepResult } from '../../flow/step-result.ts';
import type { ProjectStepRef } from '../../flow/step-runner.ts';
import type { MonorepoRootResult } from '../../init-outcome.ts';
import { remoteRepositorySlug } from '../../remote-host.ts';
import type { DetectDeps } from '../detect.ts';
import {
  announceRoot,
  type MonorepoRoot,
  noProjectForRoot,
  type RootOnboarding,
} from './root-onboarding.ts';

/**
 * No project has the root's key yet. Only the batched import can create it, bound to the
 * repository, so a root it did not bind fails with how to map an existing project instead.
 */
export class CreateRoot implements RootOnboarding {
  readonly initPath = 'unbound_new';

  constructor(
    readonly target: MonorepoRoot,
    private readonly deps: DetectDeps,
  ) {}

  get ref(): ProjectStepRef {
    return { step: 'create_project', root: this.target.root };
  }

  run(): Promise<StepResult<MonorepoRootResult>> {
    announceRoot(this.target, this.deps);
    return Promise.resolve(noProjectForRoot(this.target.path, this.canBind()));
  }

  /** Binding needs SonarQube Cloud and a GitHub or Azure DevOps remote. */
  private canBind(): boolean {
    const { remote } = this.target;
    return (
      this.deps.auth.connectionType === 'cloud' && !!remote && remoteRepositorySlug(remote) !== null
    );
  }
}
