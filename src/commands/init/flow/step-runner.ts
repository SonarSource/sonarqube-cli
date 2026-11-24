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

import type { InitTelemetryRecorder } from '../telemetry/init-telemetry-recorder.ts';
import type { InitPathId, ProjectStepId, RunStepId } from './step-ids.ts';
import type { StepResult } from './step-result.ts';

/** A project root of the run: its position in the run, and the directory it maps. */
export interface InitRoot {
  index: number;
  path: string;
}

/** A run-level step, or a project step together with the root it runs for. */
export type StepRef =
  { step: RunStepId; root?: undefined } | { step: ProjectStepId; root: InitRoot };

export type ProjectStepRef = Extract<StepRef, { root: InitRoot }>;

/** A root the run found, with the path it is expected to take. */
export interface DetectedRoot {
  root: InitRoot;
  initPath: InitPathId;
}

/** A root a detection found, with what onboarding it needs to know: the same shape for one directory or many. */
export interface Detected<T> extends DetectedRoot {
  target: T;
}

/** One onboarding step: which step it is, and what it does. Every step is a class that implements it. */
export interface InitStep<T> {
  readonly ref: StepRef;
  /** Set on a project step that puts its root on a path; how the step ends may still change it. */
  readonly initPath?: InitPathId;
  run(): Promise<StepResult<T>>;
}

/** Runs the onboarding steps one at a time and records in telemetry how each one went. */
export class StepRunner {
  constructor(private readonly telemetry?: InitTelemetryRecorder) {}

  async run<T>(step: InitStep<T>): Promise<T> {
    const { ref, initPath } = step;
    if (ref.root && initPath) {
      this.telemetry?.rootsDetected([{ root: ref.root, initPath }]);
    }
    this.telemetry?.started(ref);
    let result: StepResult<T>;
    try {
      result = await step.run();
    } catch (error) {
      this.telemetry?.failed(ref, error);
      throw error;
    }
    const { value, ...report } = result;
    this.telemetry?.finished(ref, report);
    return value;
  }
}

/** A single-project run onboards the one directory it was pointed at. */
export function singleRoot(path: string): InitRoot {
  return { index: 0, path };
}
