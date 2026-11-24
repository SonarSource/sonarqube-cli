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
import type { MonorepoRoot, RootOnboarding } from './root-onboarding.ts';

/** Looking the root's project up failed, for this root only: it fails with the error behind it. */
export class UncheckedRoot implements RootOnboarding {
  readonly initPath = 'unbound_new';

  constructor(
    readonly target: MonorepoRoot,
    private readonly reason: string,
    private readonly cause: unknown,
  ) {}

  get ref(): ProjectStepRef {
    return { step: 'link', root: this.target.root };
  }

  run(): Promise<StepResult<MonorepoRootResult>> {
    return Promise.resolve(
      failed({ path: this.target.path, kind: 'failed', reason: this.reason }, this.cause),
    );
  }
}
