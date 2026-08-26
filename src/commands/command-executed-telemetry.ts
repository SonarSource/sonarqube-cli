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

import { DISTRIBUTION, type Distribution } from '@/core/host/distribution.ts';
import { tryLoadState } from '@/core/state/state-manager.ts';
import { isTelemetryEnabled } from '@/core/telemetry/enabled.ts';
import { scheduleTelemetryFlush, TELEMETRY_FLUSH_MODE_ENV } from '@/core/telemetry/index.ts';
import { currentProjectUuid } from '@/core/telemetry/project-uuid.ts';
import { emitTelemetryEvent } from '@/core/telemetry/telemetry-events.ts';

export const CLI_COMMAND_EXECUTED = 'CliCommandExecuted';

/** Domain payload for CliCommandExecuted (identity is filled by core emit). */
export type CommandExecutedPayload = {
  command: string | undefined;
  subcommand: string | null;
  result: 'success' | 'failure';
  distribution: Distribution;
  project_uuid: string | null;
};

// Passthrough commands (e.g. `sonar context`) own a single Command node, so the
// usual parent-chain walk cannot recover the forwarded subcommand. The handler
// publishes the resolved subcommand here and storeEvent reads it back.
const passthroughSubcommands = new WeakMap<Command, string | null>();

export function setPassthroughSubcommand(command: Command, subcommand: string | null): void {
  passthroughSubcommands.set(command, subcommand);
}

/**
 * Emit one CliCommandExecuted event for a finished command and spawn the detached flush
 * worker that drains telemetry-events.ndjson.
 *
 * No-ops when called from within a flush worker (prevents infinite recursion) or when
 * telemetry is disabled.
 *
 * `agentSessionId` is resolved by the caller (buildCommandTree postAction) so session
 * identification stays outside SonarCommand / CliRuntime.
 */
export async function storeEvent(
  command: Command,
  success: boolean,
  agentSessionId: string | null = null,
): Promise<void> {
  if (process.env[TELEMETRY_FLUSH_MODE_ENV]) return;
  const state = tryLoadState();
  if (!state || !isTelemetryEnabled(state)) return;

  const commandNames: string[] = [];
  let current: Command = command;
  while (current.parent !== null) {
    commandNames.unshift(current.name());
    current = current.parent;
  }
  const topCommand = commandNames[0];
  const commandPathTail = commandNames.slice(1);
  const fallbackSubcommand = commandPathTail.length > 0 ? commandPathTail.join(' ') : null;
  const subcommand = passthroughSubcommands.has(command)
    ? (passthroughSubcommands.get(command) ?? null)
    : fallbackSubcommand;

  await emitTelemetryEvent(
    CLI_COMMAND_EXECUTED,
    {
      command: topCommand,
      subcommand,
      result: success ? 'success' : 'failure',
      distribution: DISTRIBUTION,
      project_uuid: await currentProjectUuid(),
    } satisfies CommandExecutedPayload,
    { agentSessionId },
  );

  scheduleTelemetryFlush();
}
