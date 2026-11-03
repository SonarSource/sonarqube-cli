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

import {
  type CommandAuthenticatedInvocationContext,
  TelemetryFact,
} from '@/core/commands/invocation-context.ts';

export const CLI_ARCHITECTURE_SET = 'CliArchitectureSet';

/** Domain payload for CliArchitectureSet (identity is filled at drain time). */
export interface ArchitectureSetPayload {
  target: 'intended' | 'directives';
  mode: string;
  dry_run: boolean;
  removed: number;
  added: number;
  changed: number;
  created: number;
  skipped: number;
}

export interface SetFileOptions {
  project?: string;
  file: string;
  dryRun?: boolean;
}

export function recordSet(
  ctx: CommandAuthenticatedInvocationContext,
  payload: ArchitectureSetPayload,
): void {
  ctx.recordTelemetry(
    new TelemetryFact<ArchitectureSetPayload>(CLI_ARCHITECTURE_SET, payload, {
      auth: ctx.auth,
    }),
  );
}
