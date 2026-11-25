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

import type { InitPathId } from '../flow/step-ids.ts';
import type { InitStep } from '../flow/step-runner.ts';
import type { InitOutcome, InitPath } from '../init-outcome.ts';
import { BoundNewStep } from './bind.ts';
import { CompleteLinkStep } from './complete-link.ts';
import type { DetectDeps } from './detect.ts';
import { LinkExistingStep } from './link-existing.ts';
import { NoProjectStep } from './no-project.ts';

/** How the directory is onboarded: the step it takes, and the path it is expected to take. */
export interface PathOnboarding extends InitStep<InitOutcome> {
  /** Its step may still change it, as when a declined authorization leaves no project. */
  readonly initPath: InitPathId;
}

/** Decides how the directory is onboarded, once its path is known. */
export function planPath(path: InitPath, deps: DetectDeps): PathOnboarding {
  switch (path.path) {
    case 'complete':
      return new CompleteLinkStep(path, deps);
    case 'link-existing':
      return new LinkExistingStep(path, deps);
    case 'bound-new':
      return new BoundNewStep(path, deps);
    case 'no-project':
      return new NoProjectStep(path, deps);
  }
}
