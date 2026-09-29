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

import { spawn } from 'node:child_process';
import { constants } from 'node:os';

import { CommandFailedError, InvalidOptionError } from '@/core/commands/command-error.ts';
import type { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import { buildSubprocessNetworkEnv } from '@/core/host/connectivity/network-config.ts';
import { getToken } from '@/core/host/keychain.ts';
import { discoverProject } from '@/core/project-info.ts';
import { INVOCATION_ID } from '@/core/telemetry/invocation-id.ts';

export async function runTui(ctx: CommandAuthenticatedInvocationContext): Promise<void> {
  const override = process.env.SONAR_TUI_BINARY;
  if (override !== undefined && override.trim().length === 0) {
    throw new InvalidOptionError('SONAR_TUI_BINARY must not be empty.');
  }
  const binaryPath = override ?? 'sonar-tui';
  const project = await discoverProject(process.cwd(), {
    auth: ctx.auth,
    silent: true,
    console: ctx.console,
  });
  const serverUrl = project.serverUrl ?? ctx.auth.serverUrl;
  const organization =
    project.organization ?? (serverUrl === ctx.auth.serverUrl ? ctx.auth.orgKey : undefined);
  const token =
    serverUrl === ctx.auth.serverUrl && organization === ctx.auth.orgKey
      ? ctx.auth.token
      : await getToken(serverUrl, organization);
  if (!token) {
    throw new CommandFailedError('Not authenticated for the discovered project connection.', {
      remediationHint: 'Run: sonar auth login for the project server and organization.',
    });
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...buildSubprocessNetworkEnv(),
    SONAR_TOKEN: token,
    SONAR_HOST_URL: serverUrl,
    SONAR_ORGANIZATION: organization ?? '',
    SONAR_TUI_PROJECT: project.projectKey ?? '',
    SONAR_TUI_WORKSPACE_ROOT: project.projectRoot,
    SONAR_TUI_INVOCATION_ID: INVOCATION_ID,
  };

  await new Promise<void>((resolve, reject) => {
    const child = spawn(binaryPath, [], { stdio: 'inherit', env });
    const forwardInterrupt = () => child.kill('SIGINT');
    const forwardTerminate = () => child.kill('SIGTERM');
    const cleanup = () => {
      process.off('SIGINT', forwardInterrupt);
      process.off('SIGTERM', forwardTerminate);
    };
    process.on('SIGINT', forwardInterrupt);
    process.on('SIGTERM', forwardTerminate);
    child.once('error', (cause: NodeJS.ErrnoException) => {
      cleanup();
      reject(
        new CommandFailedError(
          cause.code === 'ENOENT' ? 'TUI binary not found.' : 'Unable to launch the TUI binary.',
          {
            cause,
            remediationHint:
              'Build the Rust TUI with cargo build --release, then set SONAR_TUI_BINARY to its executable path, or put sonar-tui on PATH.',
          },
        ),
      );
    });
    child.once('close', (code, signal) => {
      cleanup();
      const signalNumber = signal ? constants.signals[signal] : undefined;
      process.exitCode = code ?? (signalNumber ? 128 + signalNumber : 1);
      resolve();
    });
  });
}
