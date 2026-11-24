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

import { alreadyDone, type StepResult } from '../../flow/step-result.ts';
import type { ProjectStepRef } from '../../flow/step-runner.ts';
import type { MonorepoRootResult } from '../../init-outcome.ts';
import type { MonorepoRoot, RootOnboarding } from './root-onboarding.ts';

/** The file links the root and the remote has its project: nothing to do. */
export class ConfiguredRoot implements RootOnboarding {
  readonly initPath = 'already_done';

  constructor(readonly target: MonorepoRoot) {}

  get ref(): ProjectStepRef {
    return { step: 'link', root: this.target.root };
  }

  run(): Promise<StepResult<MonorepoRootResult>> {
    const { path, mapping } = this.target;
    const { projectKey, serverUrl } = mapping;
    return Promise.resolve(
      alreadyDone({ path, kind: 'configured', projectKey, serverUrl }, { projectKey }),
    );
  }
}
