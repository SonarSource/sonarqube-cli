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

import { classifyInitFailure } from './failure-reason.ts';
import {
  buildInitExecutedFact,
  buildProjectInitFact,
  encodeStep,
  type InitFailureReason,
  type InitPathId,
  type InitRemoteHost,
  type InitStepId,
  type InitStepOutcome,
  type ProjectInitPayload,
  type ProjectStepId,
  type RunStepId,
  toProjectFailureReason,
} from './init-telemetry.ts';

// A failed sign-in with no more specific cause is an authentication failure.
const FALLBACK_REASONS: Partial<Record<InitStepId, InitFailureReason>> = { login: 'auth' };

interface Stop<S extends InitStepId> {
  step: S | null;
  reason: InitFailureReason;
}

/** Steps reached in order, with the one in progress, so a thrown error lands on the right step. */
class StepLog<S extends InitStepId> {
  private readonly steps: { step: S; outcome: InitStepOutcome }[] = [];
  private pending: S | undefined;
  private declined: S | undefined;
  stop: Stop<S> | undefined;

  begin(step: S): void {
    this.pending = step;
  }

  record(step: S, outcome: InitStepOutcome): void {
    this.steps.push({ step, outcome });
    if (outcome === 'declined') {
      this.declined = step;
    }
    if (this.pending === step) {
      this.pending = undefined;
    }
  }

  inProgress(): S | undefined {
    return this.pending;
  }

  /** Marks the step in progress, if any, as failed; the first stop recorded wins. */
  fail(error: unknown): Stop<S> {
    if (this.stop) {
      return this.stop;
    }
    const step = this.pending ?? null;
    if (step) {
      this.record(step, 'failed');
    }
    this.stop = {
      step,
      reason: classifyInitFailure(error, step ? FALLBACK_REASONS[step] : undefined),
    };
    return this.stop;
  }

  stopAt(step: S, reason: InitFailureReason): void {
    this.stop ??= { step, reason };
  }

  lastDeclined(): S | undefined {
    return this.declined;
  }

  encoded(): `${S}:${InitStepOutcome}`[] {
    return this.steps.map(({ step, outcome }) => encodeStep(step, outcome));
  }
}

/** One project root of the run: the path it took, its steps and where it stopped. */
export class ProjectInitRecorder {
  private readonly log = new StepLog<ProjectStepId>();
  private projectKey: string | undefined;
  private firstAnalysisDurationMs: number | null = null;

  constructor(
    readonly index: number,
    private path: InitPathId,
  ) {}

  setPath(path: InitPathId): void {
    this.path = path;
  }

  setProjectKey(projectKey: string): void {
    this.projectKey = projectKey;
  }

  setFirstAnalysisDuration(durationMs: number): void {
    this.firstAnalysisDurationMs = Math.round(durationMs);
  }

  begin(step: ProjectStepId): void {
    this.log.begin(step);
  }

  record(step: ProjectStepId, outcome: InitStepOutcome): void {
    this.log.record(step, outcome);
  }

  inProgress(): ProjectStepId | undefined {
    return this.log.inProgress();
  }

  fail(error: unknown): Stop<ProjectStepId> {
    return this.log.fail(error);
  }

  stopAt(step: ProjectStepId, reason: InitFailureReason): void {
    this.log.stopAt(step, reason);
  }

  lastDeclined(): ProjectStepId | undefined {
    return this.log.lastDeclined();
  }

  key(): string | undefined {
    return this.projectKey;
  }

  payload(projectUuid: string | null): ProjectInitPayload {
    const { stop } = this.log;
    return {
      init_path: this.path,
      steps: this.log.encoded(),
      stopped_at: stop?.step ?? null,
      failure_reason: stop ? toProjectFailureReason(stop.reason) : null,
      project_index: this.index,
      project_uuid: projectUuid,
      first_analysis_duration_ms: this.firstAnalysisDurationMs,
    };
  }
}

export interface InitRunContext {
  auth: ResolvedAuth | undefined;
  isInteractive: boolean;
  remoteHost: InitRemoteHost | null;
  repoRoot: string | null;
  /** Time spent on prompts and browser steps during the run. */
  userWaitMs: number;
}

/**
 * Collects what one `sonar init` run reached, then records one CliInitExecuted fact and one
 * CliProjectInitCreationAttempted fact per project root, or none when the roots were never known.
 */
export class InitTelemetryRecorder {
  private readonly startedAt = performance.now();
  private readonly log = new StepLog<RunStepId>();
  private projects: ProjectInitRecorder[] | undefined;
  private active: ProjectInitRecorder | undefined;
  private runStop: Stop<InitStepId> | undefined;

  constructor(private readonly isMonorepo: boolean) {}

  begin(step: RunStepId): void {
    this.log.begin(step);
  }

  record(step: RunStepId, outcome: InitStepOutcome): void {
    this.log.record(step, outcome);
  }

  /** The roots are known: the run reports one project event per path, in this order. */
  setProjects(paths: readonly InitPathId[]): ProjectInitRecorder[] {
    this.projects = paths.map((path, index) => new ProjectInitRecorder(index, path));
    this.active = this.projects.length === 1 ? this.projects[0] : undefined;
    return this.projects;
  }

  project(index: number): ProjectInitRecorder | undefined {
    return this.projects?.[index];
  }

  /** The root a thrown error is attributed to while it is being onboarded. */
  setActiveProject(project: ProjectInitRecorder | undefined): void {
    this.active = project;
  }

  /**
   * Attributes the error to the step in progress. A single-project run ends with its project, so
   * the run stops at the project's step; a monorepo run only names its own steps.
   */
  fail(error: unknown): void {
    if (this.runStop) {
      return;
    }
    const project = this.active?.inProgress() ? this.active : undefined;
    if (!this.log.inProgress() && project) {
      const stop = project.fail(error);
      this.runStop = this.isMonorepo ? { step: null, reason: stop.reason } : stop;
      return;
    }
    this.runStop = this.log.fail(error);
  }

  stopAt(step: RunStepId, reason: InitFailureReason): void {
    this.runStop ??= { step, reason };
  }

  /** The user declined every option, which the run reports as a cancellation at the last refusal. */
  stopAtDeclined(): void {
    const project = this.isMonorepo ? undefined : this.active;
    const projectStep = project?.lastDeclined();
    if (project && projectStep) {
      project.stopAt(projectStep, 'cancelled');
      this.runStop ??= { step: projectStep, reason: 'cancelled' };
      return;
    }
    this.runStop ??= { step: this.log.lastDeclined() ?? null, reason: 'cancelled' };
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
          duration_ms: Math.round(performance.now() - this.startedAt),
          user_wait_ms: run.userWaitMs,
        },
        run.auth,
      ),
      ...projects.map((project, index) =>
        buildProjectInitFact(project.payload(uuids[index]), run.auth),
      ),
    );
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
