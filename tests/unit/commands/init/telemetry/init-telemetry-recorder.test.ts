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

import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from 'bun:test';

import { OnboardingCancelledError } from '@/commands/init/answer.ts';
import type { InitPathId, InitStepOutcome } from '@/commands/init/flow/step-ids.ts';
import { type StepResult, success } from '@/commands/init/flow/step-result.ts';
import { type InitRoot, StepRunner } from '@/commands/init/flow/step-runner.ts';
import {
  CLI_INIT_EXECUTED,
  CLI_PROJECT_INIT_CREATION_ATTEMPTED,
  type InitExecutedPayload,
  type ProjectInitPayload,
} from '@/commands/init/telemetry/init-telemetry.ts';
import {
  type InitRunContext,
  InitTelemetryRecorder,
} from '@/commands/init/telemetry/init-telemetry-recorder.ts';
import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { ForbiddenApiError, TransportError } from '@/core/server/errors.ts';
import * as projectUuid from '@/core/telemetry/project-uuid.ts';

import { FakeConsole } from '../../../../_common/fake-console.ts';
import { ScriptedStep } from '../scripted-step.ts';

const AUTH = new ResolvedAuth({
  connectionType: 'cloud',
  source: 'state' as const,
  serverUrl: 'https://sonarcloud.io',
  token: 'test-token',
  orgKey: 'my-org',
});

const RUN: InitRunContext = {
  auth: AUTH,
  isInteractive: true,
  remoteHost: 'github',
  repoRoot: '/some/repo',
};

const ROOT: InitRoot = { index: 0, path: '/some/repo' };

let resolveUuids: Mock<typeof projectUuid.resolveProjectUuids>;

beforeEach(() => {
  resolveUuids = spyOn(projectUuid, 'resolveProjectUuids').mockImplementation((projects) =>
    Promise.resolve(projects.map(({ projectKey }) => `uuid-of-${projectKey}`)),
  );
});

afterEach(() => {
  resolveUuids.mockRestore();
});

/** A recorder watching a runner, as `sonar init` wires them. */
function watched(isMonorepo = false): { recorder: InitTelemetryRecorder; steps: StepRunner } {
  const recorder = new InitTelemetryRecorder(isMonorepo);
  return { recorder, steps: new StepRunner(recorder) };
}

function roots(...initPaths: InitPathId[]): { root: InitRoot; initPath: InitPathId }[] {
  return initPaths.map((initPath, index) => ({ root: { index, path: `root-${index}` }, initPath }));
}

function done(
  outcome: InitStepOutcome,
  value?: unknown,
  projectKey?: string,
): () => Promise<StepResult<unknown>> {
  return () => Promise.resolve({ outcome, value, projectKey });
}

async function thrownBy(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

async function emit(
  recorder: InitTelemetryRecorder,
  run: InitRunContext = RUN,
): Promise<{ run: InitExecutedPayload; projects: ProjectInitPayload[] }> {
  const ctx = new CommandInvocationContext(new FakeConsole());
  await recorder.emit(ctx, run);
  const [runFact, ...projectFacts] = ctx.telemetryFacts();
  expect(runFact.name).toBe(CLI_INIT_EXECUTED);
  for (const fact of projectFacts) {
    expect(fact.name).toBe(CLI_PROJECT_INIT_CREATION_ATTEMPTED);
  }
  return {
    run: runFact.payload as InitExecutedPayload,
    projects: projectFacts.map((fact) => fact.payload as ProjectInitPayload),
  };
}

describe('InitTelemetryRecorder', () => {
  it('reports a successful single-project run with its project', async () => {
    const { recorder, steps } = watched();
    await steps.run(new ScriptedStep({ step: 'login' }, done('already_done')));
    await steps.run(new ScriptedStep({ step: 'detect' }, done('success')));
    recorder.rootsDetected([{ root: ROOT, initPath: 'unbound_new' }]);
    await steps.run(new ScriptedStep({ step: 'project_bind', root: ROOT }, done('skipped')));
    await steps.run(
      new ScriptedStep(
        { step: 'create_project', root: ROOT },
        done('success', undefined, 'my-project'),
      ),
    );
    await steps.run(new ScriptedStep({ step: 'integrate' }, done('declined')));

    const { run, projects } = await emit(recorder);

    expect(run).toMatchObject({
      steps: ['login:already_done', 'detect:success', 'integrate:declined'],
      stopped_at: null,
      failure_reason: null,
      project_count: 1,
      is_interactive: true,
      is_monorepo: false,
      remote_host: 'github',
    });
    expect(run.repo_id).toHaveLength(64);
    expect(projects).toEqual([
      {
        init_path: 'unbound_new',
        steps: ['project_bind:skipped', 'create_project:success'],
        stopped_at: null,
        failure_reason: null,
        project_index: 0,
        project_uuid: 'uuid-of-my-project',
      },
    ]);
  });

  it('emits no project event when the run stops before the roots are known', async () => {
    const { recorder, steps } = watched();
    await thrownBy(
      steps.run(
        new ScriptedStep({ step: 'login' }, () =>
          Promise.reject(new CommandFailedError('Not signed in.')),
        ),
      ),
    );

    const { run, projects } = await emit(recorder, { ...RUN, auth: undefined });

    expect(run).toMatchObject({
      steps: ['login:failed'],
      stopped_at: 'login',
      failure_reason: 'auth',
      project_count: 0,
    });
    expect(projects).toEqual([]);
    expect(resolveUuids).not.toHaveBeenCalled();
  });

  it('lists a step nested in another one after it, as they started', async () => {
    const { recorder, steps } = watched();
    await steps.run(
      new ScriptedStep({ step: 'login' }, async () => {
        await steps.run(new ScriptedStep({ step: 'create_org' }, done('declined')));
        return success(undefined);
      }),
    );

    expect((await emit(recorder)).run.steps).toEqual(['login:success', 'create_org:declined']);
  });

  it('stops at the inner step when its failure also ends the outer one', async () => {
    const { recorder, steps } = watched();
    const failure = new TransportError('offline');

    await thrownBy(
      steps.run(
        new ScriptedStep({ step: 'login' }, () =>
          steps.run(new ScriptedStep({ step: 'create_org' }, () => Promise.reject(failure))),
        ),
      ),
    );

    expect((await emit(recorder)).run).toMatchObject({
      steps: ['login:failed', 'create_org:failed'],
      stopped_at: 'create_org',
      failure_reason: 'network',
    });
  });

  it('stops a single-project run at the failed project step', async () => {
    const { recorder, steps } = watched();
    await steps.run(new ScriptedStep({ step: 'detect' }, done('success')));
    recorder.rootsDetected([{ root: ROOT, initPath: 'unbound_new' }]);

    await thrownBy(
      steps.run(
        new ScriptedStep({ step: 'create_project', root: ROOT }, () =>
          Promise.reject(new ForbiddenApiError('no')),
        ),
      ),
    );

    const { run, projects } = await emit(recorder);
    expect(run.stopped_at).toBe('create_project');
    expect(run.failure_reason).toBe('permission');
    expect(projects[0]).toMatchObject({
      steps: ['create_project:failed'],
      stopped_at: 'create_project',
      failure_reason: 'permission',
      project_uuid: null,
    });
  });

  it('lets a monorepo run carry on past a failed root, and only names its own steps', async () => {
    const { recorder, steps } = watched(true);
    recorder.rootsDetected(roots('link_existing', 'unbound_new'));
    const [linked, failed] = [
      { index: 0, path: 'root-0' },
      { index: 1, path: 'root-1' },
    ];
    await steps.run(
      new ScriptedStep({ step: 'link', root: linked }, done('success', undefined, 'linked-key')),
    );
    await thrownBy(
      steps.run(
        new ScriptedStep({ step: 'create_project', root: failed }, () =>
          Promise.reject(new TransportError('offline')),
        ),
      ),
    );
    await thrownBy(
      steps.run(
        new ScriptedStep({ step: 'integrate' }, () =>
          Promise.reject(new OnboardingCancelledError()),
        ),
      ),
    );

    const { run, projects } = await emit(recorder);

    expect(run).toMatchObject({ stopped_at: 'integrate', failure_reason: 'cancelled' });
    expect(
      projects.map(({ stopped_at, failure_reason, project_uuid }) => ({
        stopped_at,
        failure_reason,
        project_uuid,
      })),
    ).toEqual([
      { stopped_at: null, failure_reason: null, project_uuid: 'uuid-of-linked-key' },
      { stopped_at: 'create_project', failure_reason: 'network', project_uuid: null },
    ]);
  });

  it('leaves the run-level step empty when a monorepo root ends the run', async () => {
    const { recorder, steps } = watched(true);
    recorder.rootsDetected(roots('link_existing'));
    const cancel = new OnboardingCancelledError();

    await thrownBy(
      steps.run(
        new ScriptedStep({ step: 'link', root: { index: 0, path: 'root-0' } }, () =>
          Promise.reject(cancel),
        ),
      ),
    );
    recorder.failRun(cancel);

    const { run, projects } = await emit(recorder);
    expect(run.stopped_at).toBeNull();
    expect(run.failure_reason).toBe('cancelled');
    expect(projects[0].stopped_at).toBe('link');
  });

  it('carries on past a run-level step that ends failed without an error', async () => {
    const { recorder, steps } = watched();
    await steps.run(new ScriptedStep({ step: 'integrate' }, done('failed')));

    const { run } = await emit(recorder);

    expect(run.steps).toEqual(['integrate:failed']);
    expect(run.stopped_at).toBeNull();
  });

  it('stops a root at a step that ends failed without an error', async () => {
    const { recorder, steps } = watched(true);
    recorder.rootsDetected(roots('link_existing'));
    await steps.run(
      new ScriptedStep({ step: 'link', root: { index: 0, path: 'root-0' } }, done('failed')),
    );

    const [project] = (await emit(recorder)).projects;

    expect(project).toMatchObject({ stopped_at: 'link', failure_reason: 'unknown' });
  });

  it('classifies the cause a root returns with its failure, and applies the path it ended on', async () => {
    const { recorder, steps } = watched(true);
    recorder.rootsDetected(roots('unbound_new'));
    const root = { index: 0, path: 'root-0' };

    await steps.run(
      new ScriptedStep({ step: 'create_project', root: root }, () =>
        Promise.resolve({
          outcome: 'failed',
          value: undefined,
          initPath: 'bound_new',
          cause: new ForbiddenApiError('no'),
        }),
      ),
    );

    const [project] = (await emit(recorder)).projects;

    expect(project).toMatchObject({
      init_path: 'bound_new',
      stopped_at: 'create_project',
      failure_reason: 'permission',
    });
  });

  it('knows the roots a detection reports, with their expected paths', async () => {
    const { recorder, steps } = watched(true);
    const found = roots('link_existing', 'unbound_new');
    await steps.run(
      new ScriptedStep({ step: 'detect' }, () => Promise.resolve(success(found, { roots: found }))),
    );

    const { run, projects } = await emit(recorder);

    expect(run.steps).toEqual(['detect:success']);
    expect(projects.map(({ init_path }) => init_path)).toEqual(['link_existing', 'unbound_new']);
  });

  it('puts a root on the path its step runs on, registering the root when it was not known', async () => {
    const { recorder, steps } = watched();
    await steps.run(
      new ScriptedStep({ step: 'project_bind', root: ROOT }, done('declined'), 'bound_new'),
    );
    await steps.run(
      new ScriptedStep({ step: 'create_project', root: ROOT }, done('declined'), 'unbound_new'),
    );

    const [project] = (await emit(recorder)).projects;

    expect(project).toMatchObject({
      init_path: 'unbound_new',
      steps: ['project_bind:declined', 'create_project:declined'],
    });
  });

  it('updates the path of a root named again by detection', async () => {
    const { recorder, steps } = watched();
    recorder.rootsDetected([{ root: ROOT, initPath: 'bound_new' }]);
    await steps.run(new ScriptedStep({ step: 'project_bind', root: ROOT }, done('declined')));
    recorder.rootsDetected([{ root: ROOT, initPath: 'unbound_new' }]);

    const [project] = (await emit(recorder)).projects;

    expect(project).toMatchObject({ init_path: 'unbound_new', steps: ['project_bind:declined'] });
  });

  it('reports declining every option as cancelled at the last refusal', async () => {
    const { recorder, steps } = watched();
    recorder.rootsDetected([{ root: ROOT, initPath: 'bound_new' }]);
    await steps.run(new ScriptedStep({ step: 'project_bind', root: ROOT }, done('declined')));
    recorder.rootsDetected([{ root: ROOT, initPath: 'unbound_new' }]);
    await steps.run(new ScriptedStep({ step: 'create_project', root: ROOT }, done('declined')));
    recorder.stopAtDeclined();

    const { run, projects } = await emit(recorder);

    expect(run.stopped_at).toBe('create_project');
    expect(run.failure_reason).toBe('cancelled');
    expect(projects[0]).toMatchObject({
      init_path: 'unbound_new',
      steps: ['project_bind:declined', 'create_project:declined'],
      stopped_at: 'create_project',
      failure_reason: 'cancelled',
    });
  });

  it('does not report a run as cancelled when nothing was declined', async () => {
    const { recorder, steps } = watched();
    recorder.rootsDetected([{ root: ROOT, initPath: 'unbound_new' }]);
    await steps.run(new ScriptedStep({ step: 'project_bind', root: ROOT }, done('skipped')));
    await steps.run(new ScriptedStep({ step: 'create_project', root: ROOT }, done('skipped')));
    recorder.stopAtDeclined();

    const { run, projects } = await emit(recorder);

    expect(run.stopped_at).toBeNull();
    expect(run.failure_reason).toBeNull();
    expect(projects[0].stopped_at).toBeNull();
  });

  it('keeps the first stop when a later error reaches the run', async () => {
    const { recorder, steps } = watched();
    await steps.run(new ScriptedStep({ step: 'login' }, done('already_done')));
    recorder.stopAt('create_org', 'no_org');
    recorder.failRun(new TransportError('offline'));

    const { run } = await emit(recorder);

    expect(run.stopped_at).toBe('create_org');
    expect(run.failure_reason).toBe('no_org');
  });

  it('reports an error no step saw without naming a step', async () => {
    const { recorder } = watched();
    recorder.failRun(new ForbiddenApiError('no'));

    expect((await emit(recorder)).run).toMatchObject({
      stopped_at: null,
      failure_reason: 'permission',
    });
  });
});
