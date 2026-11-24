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
import type { InitStep, ProjectStepRef } from '../../flow/step-runner.ts';
import type { MonorepoRootResult } from '../../init-outcome.ts';
import { describeFailure, isRunFatal } from '../linked-projects.ts';
import type { RootOnboarding } from './root-onboarding.ts';

/** Onboards one root so that an error that does not end the run fails only that root. */
export class IsolatedRootStep implements InitStep<MonorepoRootResult> {
  constructor(private readonly onboarding: RootOnboarding) {}

  get ref(): ProjectStepRef {
    return this.onboarding.ref;
  }

  async run(): Promise<StepResult<MonorepoRootResult>> {
    try {
      return await this.onboarding.run();
    } catch (error) {
      if (isRunFatal(error)) {
        throw error;
      }
      return this.failedRoot(error);
    }
  }

  private failedRoot(error: unknown): StepResult<MonorepoRootResult> {
    const { path } = this.onboarding.target;
    return failed({ path, kind: 'failed', reason: describeFailure(error) }, error);
  }
}
