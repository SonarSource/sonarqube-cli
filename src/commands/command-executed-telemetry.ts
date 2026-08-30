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

import { type Command } from 'commander';

import { TelemetryFact } from '@/commands/command-invocation-context.ts';
import { commitTelemetryFacts } from '@/commands/telemetry-facts.ts';
import { DISTRIBUTION, type Distribution } from '@/core/host/distribution.ts';
import { currentProjectUuid } from '@/core/telemetry/project-uuid.ts';

export const CLI_COMMAND_EXECUTED = 'CliCommandExecuted';

/** Domain payload for CliCommandExecuted (identity is filled at drain time). */
export type CommandExecutedPayload = {
  command: string | undefined;
  subcommand: string | null;
  result: 'success' | 'failure';
  distribution: Distribution;
  project_uuid: string | null;
};

const passthroughSubcommands = new WeakMap<Command, string | null>();

export function setPassthroughSubcommand(command: Command, subcommand: string | null): void {
  passthroughSubcommands.set(command, subcommand);
}

/**
 * Build a CliCommandExecuted fact for a finished command.
 *
 * `result` is derived from `process.exitCode` (`success` when 0 or unset).
 * `project_uuid` is resolved here (async, never rejects). Identity is applied at commit.
 */
export async function buildCommandExecutedFact(
  command: Command,
): Promise<TelemetryFact<CommandExecutedPayload>> {
  const commandNames: string[] = [];
  let current: Command = command;
  while (current.parent !== null) {
    commandNames.unshift(current.name());
    current = current.parent;
  }
  const commandPathTail = commandNames.slice(1);
  const fallbackSubcommand = commandPathTail.length > 0 ? commandPathTail.join(' ') : null;
  const subcommand = passthroughSubcommands.has(command)
    ? (passthroughSubcommands.get(command) ?? null)
    : fallbackSubcommand;

  return new TelemetryFact(CLI_COMMAND_EXECUTED, {
    command: commandNames[0],
    subcommand,
    result: (process.exitCode ?? 0) === 0 ? 'success' : 'failure',
    distribution: DISTRIBUTION,
    project_uuid: await currentProjectUuid(),
  });
}

/**
 * Record and commit one CliCommandExecuted fact, then schedule the flush.
 *
 * Used by unit tests that do not go through the command tree `postAction`.
 * Production drains this fact together with handler facts in `postAction`.
 */
export async function storeEvent(
  command: Command,
  agentSessionId: string | null = null,
): Promise<void> {
  await commitTelemetryFacts([await buildCommandExecutedFact(command)], {
    agentSessionId,
  });
}
