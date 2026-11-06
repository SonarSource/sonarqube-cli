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

import { TelemetryFact } from '@/core/commands/invocation-context.ts';
import type { SonarCommand } from '@/core/commands/sonar-command.ts';
import { DISTRIBUTION, type Distribution } from '@/core/host/distribution.ts';

import { resolveTelemetryTargets } from './project-uuid.ts';

export const CLI_COMMAND_EXECUTED = 'CliCommandExecuted';

export const CLI_COMMAND_TARGET = 'CliCommandTarget';

/** Domain payload for CliCommandExecuted (identity is filled at drain time). */
export type CommandExecutedPayload = {
  command: string | undefined;
  subcommand: string | null;
  result: 'success' | 'failure';
  distribution: Distribution;
  project_uuid: string | null;
  target_count: number;
  arguments: string | null;
} & Partial<typeof MULTI_TARGET_CONNECTION_FIELDS>;

/** Overrides the merged identity, so a multi-target run is never attributed to one connection. */
const MULTI_TARGET_CONNECTION_FIELDS = {
  connection_type: null,
  organization_uuid_v4: null,
  sqs_installation_id: null,
} as const;

export type CommandTargetPayload = {
  command: string | undefined;
  subcommand: string | null;
  project_uuid: string | null;
};

/**
 * Build the CliCommandExecuted fact plus one CliCommandTarget fact per noted target.
 *
 * `result` is derived from `process.exitCode` (`success` when 0 or unset). An intentional block
 * that exits non-zero (git secrets hooks, Cursor file-read denies) therefore reports `failure`;
 * the `CliAnalysisCompleted` fact on the same invocation tells a secrets block apart from an error.
 * Command/subcommand come from {@link SonarCommand.commandAndSubcommand}.
 * `arguments` comes from {@link SonarCommand.describeInvocationArguments}.
 */
export async function buildCommandFacts(command: SonarCommand): Promise<TelemetryFact[]> {
  const { command: commandName, subcommand } = command.commandAndSubcommand();
  const targets = await resolveTelemetryTargets();
  const executed = new TelemetryFact<CommandExecutedPayload>(CLI_COMMAND_EXECUTED, {
    command: commandName,
    subcommand,
    result: (process.exitCode ?? 0) === 0 ? 'success' : 'failure',
    distribution: DISTRIBUTION,
    project_uuid: targets.length === 1 ? targets[0].projectUuid : null,
    target_count: targets.length,
    arguments: command.describeInvocationArguments(),
    ...(targets.length > 1 ? MULTI_TARGET_CONNECTION_FIELDS : {}),
  });
  const targetFacts = targets.map(
    ({ auth, projectUuid }) =>
      new TelemetryFact<CommandTargetPayload>(
        CLI_COMMAND_TARGET,
        { command: commandName, subcommand, project_uuid: projectUuid },
        { auth },
      ),
  );
  return [executed, ...targetFacts];
}
