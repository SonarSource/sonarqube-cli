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

import type { InitPathId, InitStepOutcome } from './step-ids.ts';
import type { DetectedRoot } from './step-runner.ts';

/** How a step ended, and what it settled about its root. */
export interface StepReport {
  outcome: InitStepOutcome;
  /** The project the root ended up mapped to. */
  projectKey?: string;
  /** The path the root ended up taking. */
  initPath?: InitPathId;
  /** The error behind a `failed` outcome, when there was one. */
  cause?: unknown;
  /** The roots a detection found, each with the path it is expected to take. */
  roots?: readonly DetectedRoot[];
}

/** What an onboarding step did, and the value it hands to the next one. */
export interface StepResult<T> extends StepReport {
  value: T;
}

/** What a step settled: the project it mapped, the path it took when not the expected one, or the roots it found. */
type Settled = Pick<StepReport, 'projectKey' | 'initPath' | 'roots'>;

export function success<T>(value: T, settled: Settled = {}): StepResult<T> {
  return { outcome: 'success', value, ...settled };
}

export function alreadyDone<T>(
  value: T,
  settled: Pick<Settled, 'projectKey' | 'roots'> = {},
): StepResult<T> {
  return { outcome: 'already_done', value, ...settled };
}

export function skipped<T>(value: T): StepResult<T> {
  return { outcome: 'skipped', value };
}

export function declined<T>(value: T): StepResult<T> {
  return { outcome: 'declined', value };
}

/** The step could not do its part, and returns instead of throwing `cause`. */
export function failed<T>(value: T, cause?: unknown): StepResult<T> {
  return { outcome: 'failed', value, cause };
}
