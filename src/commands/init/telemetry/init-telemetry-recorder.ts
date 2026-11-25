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

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { resolveProjectUuids } from '@/core/telemetry/project-uuid.ts';
import { hashRepoRoot } from '@/core/telemetry/repo-id.ts';

import type {
  InitPathId,
  InitStepId,
  InitStepOutcome,
  InitStopReason,
  ProjectStepId,
  RunStepId,
} from '../flow/step-ids.ts';
import type { StepReport } from '../flow/step-result.ts';
import type { DetectedRoot, InitRoot, ProjectStepRef, StepRef } from '../flow/step-runner.ts';
import { classifyInitFailure } from './failure-reason.ts';
import {
  buildInitExecutedFact,
  buildProjectInitFact,
  encodeStep,
  type InitFailureReason,
  type InitRemoteHost,
  type ProjectInitPayload,
  toProjectFailureReason,
} from './init-telemetry.ts';

// A failed sign-in with no more specific cause is an authentication failure.
const FALLBACK_REASONS: Partial<Record<InitStepId, InitFailureReason>> = { login: 'auth' };

interface Stop<S extends InitStepId> {
  step: S | null;
  reason: InitFailureReason;
}

/** The steps reached, in the order they started; a step nested in another one comes after it. */
class StepLog<S extends InitStepId> {
  private readonly entries: { step: S; outcome?: InitStepOutcome }[] = [];
  private declined: S | undefined;
  stop: Stop<S> | undefined;

  start(step: S): void {
    this.entries.push({ step });
  }

  finish(step: S, outcome: InitStepOutcome): void {
    const open = this.entries.filter((entry) => entry.step === step && !entry.outcome).at(-1);
    if (open) {
      open.outcome = outcome;
    } else {
      this.entries.push({ step, outcome });
    }
    if (outcome === 'declined') {
      this.declined = step;
    }
  }

  /** The first stop wins: an inner step's failure also ends the outer step it ran in. */
  fail(step: S, error: unknown): Stop<S> {
    this.finish(step, 'failed');
    this.stop ??= { step, reason: classifyInitFailure(error, FALLBACK_REASONS[step]) };
    return this.stop;
  }

  stopAt(step: S, reason: InitFailureReason): void {
    this.stop ??= { step, reason };
  }

  lastDeclined(): S | undefined {
    return this.declined;
  }

  encoded(): `${S}:${InitStepOutcome}`[] {
    return this.entries.flatMap(({ step, outcome }) =>
      outcome ? [encodeStep(step, outcome)] : [],
    );
  }
}

/** One project root of the run: the path it took, its steps and where it stopped. */
class ProjectInitRecorder extends StepLog<ProjectStepId> {
  private projectKey: string | undefined;

  constructor(
    readonly index: number,
    private initPath: InitPathId,
  ) {
    super();
  }

  setPath(initPath: InitPathId): void {
    this.initPath = initPath;
  }

  settle(step: ProjectStepId, { outcome, projectKey }: StepReport): void {
    this.finish(step, outcome);
    if (projectKey) {
      this.projectKey = projectKey;
    }
  }

  key(): string | undefined {
    return this.projectKey;
  }

  payload(projectUuid: string | null): ProjectInitPayload {
    const { stop } = this;
    return {
      init_path: this.initPath,
      steps: this.encoded(),
      stopped_at: stop?.step ?? null,
      failure_reason: stop ? toProjectFailureReason(stop.reason) : null,
      project_index: this.index,
      project_uuid: projectUuid,
    };
  }
}

export interface InitRunContext {
  auth: ResolvedAuth | undefined;
  isInteractive: boolean;
  remoteHost: InitRemoteHost | null;
  repoRoot: string | null;
}

/**
 * Follows the steps of one `sonar init` run, then records one CliInitExecuted fact and one
 * CliProjectInitCreationAttempted fact per project root, or none when the roots were never known.
 * A single-project run ends with its project; a monorepo run carries on past a failed root.
 */
export class InitTelemetryRecorder {
  private readonly log = new StepLog<RunStepId>();
  private projects: ProjectInitRecorder[] | undefined;
  private runStop: Stop<InitStepId> | undefined;

  constructor(private readonly isMonorepo: boolean) {}

  started(ref: StepRef): void {
    if (ref.root) {
      this.project(ref.root)?.start(ref.step);
    } else {
      this.log.start(ref.step);
    }
  }

  /**
   * A root that ends `failed` stops there; the run carries on past a run-level step that did,
   * unless the step says it stops the run.
   */
  finished(ref: StepRef, report: StepReport): void {
    if (report.roots) {
      this.rootsDetected(report.roots);
    }
    if (ref.root) {
      this.settleProject(ref, report);
    } else {
      this.log.finish(ref.step, report.outcome);
    }
    if (report.stop) {
      this.stopWith(ref, report.stop);
    }
  }

  private settleProject(ref: ProjectStepRef, report: StepReport): void {
    const project = this.project(ref.root);
    if (report.initPath) {
      project?.setPath(report.initPath);
    }
    if (report.outcome === 'failed') {
      this.failed(ref, report.cause);
    } else {
      project?.settle(ref.step, report);
    }
  }

  failed(ref: StepRef, error: unknown): void {
    if (!ref.root) {
      const stop = this.log.fail(ref.step, error);
      this.runStop ??= stop;
      return;
    }
    const stop = this.project(ref.root)?.fail(ref.step, error);
    if (stop && !this.isMonorepo) {
      this.runStop ??= stop;
    }
  }

  /** Detection may name a root before it settles; naming it again only updates its path. */
  rootsDetected(roots: readonly DetectedRoot[]): void {
    if (this.projects) {
      roots.forEach(({ root, initPath }) => this.project(root)?.setPath(initPath));
      return;
    }
    this.projects = roots.map(
      ({ root, initPath }) => new ProjectInitRecorder(root.index, initPath),
    );
  }

  /** The run ended on an error no step reported, such as an invalid option. */
  failRun(error: unknown): void {
    this.runStop ??= { step: null, reason: classifyInitFailure(error) };
  }

  private stopWith(ref: StepRef, reason: InitStopReason): void {
    if (reason !== 'cancelled') {
      this.stopAt(ref, reason);
      return;
    }
    if (ref.root) {
      const projectStep = this.project(ref.root)?.lastDeclined();
      if (projectStep) {
        this.stopAt({ step: projectStep, root: ref.root }, reason);
        return;
      }
    }
    const runStep = this.log.lastDeclined();
    // A run that ends with nothing created, but where nothing was declined, was not cancelled.
    if (runStep) {
      this.stopAt({ step: runStep }, reason);
    }
  }

  private stopAt(ref: StepRef, reason: InitFailureReason): void {
    if (!ref.root) {
      this.runStop ??= { step: ref.step, reason };
      return;
    }
    this.project(ref.root)?.stopAt(ref.step, reason);
    if (!this.isMonorepo) {
      this.runStop ??= { step: ref.step, reason };
    }
  }

  /** Records the run's facts on `ctx`, once the run has ended. */
  async emit(ctx: CommandInvocationContext, run: InitRunContext): Promise<void> {
    const projects = this.projects ?? [];
    const uuids = await resolveUuids(projects, run.auth);
    ctx.recordTelemetry(
      buildInitExecutedFact(
        {
          steps: this.log.encoded(),
          stopped_at: this.runStop?.step ?? null,
          failure_reason: this.runStop?.reason ?? null,
          project_count: projects.length,
          is_interactive: run.isInteractive,
          is_monorepo: this.isMonorepo,
          remote_host: run.remoteHost,
          repo_id: hashRepoRoot(run.repoRoot),
        },
        run.auth,
      ),
      ...projects.map((project, index) =>
        buildProjectInitFact(project.payload(uuids[index]), run.auth),
      ),
    );
  }

  private project(root: InitRoot): ProjectInitRecorder | undefined {
    return this.projects?.[root.index];
  }
}

async function resolveUuids(
  projects: readonly ProjectInitRecorder[],
  auth: ResolvedAuth | undefined,
): Promise<(string | null)[]> {
  const keyed = projects.flatMap((project, index) => {
    const projectKey = project.key();
    return auth && projectKey ? [{ index, auth, projectKey }] : [];
  });
  const uuids: (string | null)[] = projects.map(() => null);
  if (keyed.length === 0) {
    return uuids;
  }
  const resolved = await resolveProjectUuids(keyed);
  keyed.forEach(({ index }, position) => {
    uuids[index] = resolved[position];
  });
  return uuids;
}
