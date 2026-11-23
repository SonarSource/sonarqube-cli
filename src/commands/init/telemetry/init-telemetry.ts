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
import { TelemetryFact } from '@/core/commands/invocation-context.ts';

export const CLI_INIT_EXECUTED = 'CliInitExecuted';
export const CLI_PROJECT_INIT_CREATION_ATTEMPTED = 'CliProjectInitCreationAttempted';

export type RunStepId = 'login' | 'create_org' | 'detect' | 'org_bind' | 'integrate';
export type ProjectStepId = 'project_bind' | 'create_project' | 'link' | 'first_analysis';
export type InitStepId = RunStepId | ProjectStepId;

export type InitStepOutcome = 'success' | 'already_done' | 'skipped' | 'declined' | 'failed';

export type InitFailureReason =
  'auth' | 'no_org' | 'other_org' | 'network' | 'permission' | 'cancelled' | 'unknown';
/** Organization problems end the run before any project is attempted. */
export type ProjectFailureReason = Exclude<InitFailureReason, 'no_org' | 'other_org'>;

export type InitPathId = 'already_done' | 'link_existing' | 'bound_new' | 'unbound_new';

export type InitRemoteHost = 'github' | 'gitlab' | 'azure_devops' | 'bitbucket' | 'other';

export type EncodedRunStep = `${RunStepId}:${InitStepOutcome}`;
export type EncodedProjectStep = `${ProjectStepId}:${InitStepOutcome}`;

/** Domain payload for CliInitExecuted: one per `sonar init` run. */
export type InitExecutedPayload = {
  steps: EncodedRunStep[];
  stopped_at: InitStepId | null;
  failure_reason: InitFailureReason | null;
  project_count: number;
  is_interactive: boolean;
  is_monorepo: boolean;
  remote_host: InitRemoteHost | null;
  repo_id: string | null;
};

/** Domain payload for CliProjectInitCreationAttempted: one per project root the run reached. */
export type ProjectInitPayload = {
  init_path: InitPathId;
  steps: EncodedProjectStep[];
  stopped_at: ProjectStepId | null;
  failure_reason: ProjectFailureReason | null;
  project_index: number;
  project_uuid: string | null;
  first_analysis_duration_ms: number | null;
};

export function encodeStep<S extends InitStepId>(
  step: S,
  outcome: InitStepOutcome,
): `${S}:${InitStepOutcome}` {
  return `${step}:${outcome}`;
}

export function toProjectFailureReason(reason: InitFailureReason): ProjectFailureReason {
  return reason === 'no_org' || reason === 'other_org' ? 'unknown' : reason;
}

export function buildInitExecutedFact(
  payload: InitExecutedPayload,
  auth: ResolvedAuth | undefined,
): TelemetryFact<InitExecutedPayload> {
  return new TelemetryFact(CLI_INIT_EXECUTED, payload, { auth });
}

export function buildProjectInitFact(
  payload: ProjectInitPayload,
  auth: ResolvedAuth | undefined,
): TelemetryFact<ProjectInitPayload> {
  return new TelemetryFact(CLI_PROJECT_INIT_CREATION_ATTEMPTED, payload, { auth });
}
