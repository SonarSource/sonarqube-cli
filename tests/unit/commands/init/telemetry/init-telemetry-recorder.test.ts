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

let resolveUuids: Mock<typeof projectUuid.resolveProjectUuids>;

beforeEach(() => {
  resolveUuids = spyOn(projectUuid, 'resolveProjectUuids').mockImplementation((projects) =>
    Promise.resolve(projects.map(({ projectKey }) => `uuid-of-${projectKey}`)),
  );
});

afterEach(() => {
  resolveUuids.mockRestore();
});

async function emit(
  recorder: InitTelemetryRecorder,
  run: InitRunContext = RUN,
): Promise<{ run: InitExecutedPayload; projects: ProjectInitPayload[] }> {
  const ctx = new CommandInvocationContext(new FakeConsole());
  await recorder.emit(ctx, run);
  const facts = ctx.telemetryFacts();
  const [runFact, ...projectFacts] = facts;
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
    const recorder = new InitTelemetryRecorder(false);
    recorder.record('login', 'already_done');
    recorder.record('detect', 'success');
    const [project] = recorder.setProjects(['bound_new']);
    project.record('project_bind', 'skipped');
    project.record('create_project', 'success');
    project.setProjectKey('my-project');
    recorder.record('integrate', 'declined');

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
        init_path: 'bound_new',
        steps: ['project_bind:skipped', 'create_project:success'],
        stopped_at: null,
        failure_reason: null,
        project_index: 0,
        project_uuid: 'uuid-of-my-project',
      },
    ]);
  });

  it('emits no project event when the run stops before the roots are known', async () => {
    const recorder = new InitTelemetryRecorder(false);
    recorder.begin('login');
    recorder.fail(new CommandFailedError('Not signed in.'));

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

  it('stops a single-project run at the failed project step', async () => {
    const recorder = new InitTelemetryRecorder(false);
    recorder.record('login', 'success');
    recorder.record('detect', 'success');
    const [project] = recorder.setProjects(['bound_new']);
    project.begin('create_project');
    recorder.fail(new ForbiddenApiError('forbidden'));

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

  it('never names a project step at run level on a monorepo run', async () => {
    const recorder = new InitTelemetryRecorder(true);
    recorder.record('login', 'already_done');
    recorder.record('detect', 'success');
    const [linked, failed] = recorder.setProjects(['link_existing', 'bound_new']);
    linked.record('link', 'success');
    linked.setProjectKey('linked-key');
    failed.begin('create_project');
    failed.fail(new TransportError('offline'));
    recorder.setActiveProject(failed);
    recorder.begin('integrate');
    recorder.fail(new OnboardingCancelledError());

    const { run, projects } = await emit(recorder);

    expect(run.stopped_at).toBe('integrate');
    expect(run.failure_reason).toBe('cancelled');
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
    const recorder = new InitTelemetryRecorder(true);
    const [root] = recorder.setProjects(['link_existing']);
    recorder.setActiveProject(root);
    root.begin('link');
    recorder.fail(new OnboardingCancelledError());

    const { run, projects } = await emit(recorder);

    expect(run.stopped_at).toBeNull();
    expect(run.failure_reason).toBe('cancelled');
    expect(projects[0].stopped_at).toBe('link');
  });

  it('reports declining every option as cancelled at the last refusal', async () => {
    const recorder = new InitTelemetryRecorder(false);
    recorder.record('login', 'already_done');
    recorder.record('detect', 'success');
    const [project] = recorder.setProjects(['bound_new']);
    project.record('project_bind', 'declined');
    project.record('create_project', 'declined');
    expect(recorder.stopAtDeclined()).toBe(true);

    const { run, projects } = await emit(recorder);

    expect(run.stopped_at).toBe('create_project');
    expect(run.failure_reason).toBe('cancelled');
    expect(projects[0]).toMatchObject({
      stopped_at: 'create_project',
      failure_reason: 'cancelled',
    });
  });

  it('does not report a run as cancelled when nothing was declined', async () => {
    const recorder = new InitTelemetryRecorder(false);
    recorder.record('detect', 'success');
    const [project] = recorder.setProjects(['no_project']);
    project.record('project_bind', 'skipped');
    project.record('link', 'skipped');
    expect(recorder.stopAtDeclined()).toBe(false);

    const { run, projects } = await emit(recorder);

    expect(run.stopped_at).toBeNull();
    expect(run.failure_reason).toBeNull();
    expect(projects[0].stopped_at).toBeNull();
  });

  it('keeps the first stop when a later error reaches it', async () => {
    const recorder = new InitTelemetryRecorder(false);
    recorder.record('login', 'already_done');
    recorder.stopAt('create_org', 'no_org');
    recorder.fail(new TransportError('offline'));

    const { run } = await emit(recorder);

    expect(run.stopped_at).toBe('create_org');
    expect(run.failure_reason).toBe('no_org');
  });

  it('records detection once for a single-project run and follows its path changes', async () => {
    const recorder = new InitTelemetryRecorder(false);
    recorder.begin('detect');
    recorder.detected('bound_new').record('project_bind', 'declined');
    recorder.detected('no_project').record('link', 'skipped');

    const { run, projects } = await emit(recorder);

    expect(run.steps).toEqual(['detect:success']);
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      init_path: 'no_project',
      steps: ['project_bind:declined', 'link:skipped'],
    });
  });

  it('records an already set up directory as an already done detection', async () => {
    const recorder = new InitTelemetryRecorder(false);
    recorder.detected('already_done');

    const { run } = await emit(recorder);

    expect(run.steps).toEqual(['detect:already_done']);
  });

  it('finds monorepo roots by their label', () => {
    const recorder = new InitTelemetryRecorder(true);
    const [api, web] = recorder.setProjects(['link_existing', 'bound_new'], ['api', 'web']);

    expect(recorder.projectLabelled('web')).toBe(web);
    expect(recorder.projectLabelled('api')).toBe(api);
    expect(recorder.projectLabelled('docs')).toBeUndefined();
  });

  it('tells which steps were reached', () => {
    const recorder = new InitTelemetryRecorder(false);
    recorder.record('login', 'success');
    const [project] = recorder.setProjects(['bound_new']);
    project.record('project_bind', 'skipped');

    expect(recorder.has('login')).toBe(true);
    expect(recorder.has('create_org')).toBe(false);
    expect(project.has('project_bind')).toBe(true);
    expect(project.has('link')).toBe(false);
  });
});
