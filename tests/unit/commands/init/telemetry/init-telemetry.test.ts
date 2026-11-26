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

import { describe, expect, it } from 'bun:test';

import {
  buildInitExecutedFact,
  buildProjectInitFact,
  CLI_INIT_EXECUTED,
  CLI_PROJECT_INIT_CREATION_ATTEMPTED,
  encodeStep,
  type InitExecutedPayload,
  type ProjectInitPayload,
  toProjectFailureReason,
} from '@/commands/init/telemetry/init-telemetry.ts';
import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';

const AUTH = new ResolvedAuth({
  connectionType: 'cloud',
  source: 'state' as const,
  serverUrl: 'https://sonarcloud.io',
  token: 'test-token',
  orgKey: 'my-org',
});

describe('encodeStep()', () => {
  it('joins the step and its outcome', () => {
    expect(encodeStep('login', 'success')).toBe('login:success');
    expect(encodeStep('create_project', 'skipped')).toBe('create_project:skipped');
  });
});

describe('toProjectFailureReason()', () => {
  it('keeps the reasons a project can fail with', () => {
    expect(toProjectFailureReason('permission')).toBe('permission');
    expect(toProjectFailureReason('cancelled')).toBe('cancelled');
  });

  it('maps organization reasons, which only end a run, to unknown', () => {
    expect(toProjectFailureReason('no_org')).toBe('unknown');
    expect(toProjectFailureReason('other_org')).toBe('unknown');
  });
});

describe('fact builders', () => {
  it('builds a CliInitExecuted fact carrying the auth', () => {
    const payload: InitExecutedPayload = {
      steps: ['login:already_done', 'detect:success'],
      stopped_at: null,
      failure_reason: null,
      project_count: 1,
      is_interactive: true,
      is_monorepo: false,
      remote_host: 'github',
      repo_id: null,
    };

    const fact = buildInitExecutedFact(payload, AUTH);

    expect(fact.name).toBe(CLI_INIT_EXECUTED);
    expect(fact.payload).toEqual(payload);
    expect(fact.auth).toBe(AUTH);
  });

  it('builds a CliProjectInitCreationAttempted fact', () => {
    const payload: ProjectInitPayload = {
      init_path: 'bound_new',
      steps: ['create_project:success'],
      stopped_at: null,
      failure_reason: null,
      project_index: 0,
      project_uuid: 'uuid-1',
    };

    const fact = buildProjectInitFact(payload, undefined);

    expect(fact.name).toBe(CLI_PROJECT_INIT_CREATION_ATTEMPTED);
    expect(fact.payload).toEqual(payload);
    expect(fact.auth).toBeUndefined();
  });
});
