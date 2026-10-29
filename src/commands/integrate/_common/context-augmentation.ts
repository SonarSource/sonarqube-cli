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
import { CommandFailedError } from '@/core/commands/command-error.ts';
import { SONAR_CONTEXT_INVOCATION } from '@/core/config-constants.ts';
import {
  buildContextAugmentationEnv,
  type ContextAugmentationEnvContext,
} from '@/core/host/context-augmentation-env.ts';
import { SONAR_CONTEXT_AUGMENTATION_VERSION } from '@/core/host/install/signatures.ts';
import logger from '@/core/observability/logger.ts';
import { ProcessTimedOutError, spawnProcessWithTimeout } from '@/core/process/process.ts';
import type { IntegrationStateAttribute } from '@/core/state/state.ts';
import type { Console, OutputChannel } from '@/core/ui/console.ts';

// Type-only, so it does not create a runtime cycle with vortex.ts.
import type { ResolvedVortexSetup } from './vortex.ts';

const COMMAND_TIMEOUT_MS = 30_000;
const INTEGRATE_TIMEOUT_MS = 2 * 60 * 1000;

export const ENV_SKIP_CAG = '__SQCLI_DEV_SKIP_CAG';

/** True when __SQCLI_DEV_SKIP_CAG is set to 1. */
export function isContextAugmentationSkipped(): boolean {
  return process.env[ENV_SKIP_CAG]?.trim() === '1';
}

const CAG_HOOK_ORG_ALLOWLIST = new Set([
  'sonarsource',
  'denis-troller-sonar',
  'tom-howlett-sonarsource',
  'sonarsourceresearch',
]);

export function isCagHookOrgAllowed(orgKey: string | undefined): boolean {
  return orgKey !== undefined && CAG_HOOK_ORG_ALLOWLIST.has(orgKey.toLowerCase());
}

/** Context-Augmentation-specific persisted attrs (connection + SCA flag). */
export function buildContextAugmentationAttrs(
  serverUrl: string,
  orgKey: string | undefined,
  scaEnabled: boolean,
): Record<string, IntegrationStateAttribute> {
  return {
    orgKey: orgKey ?? null,
    scaEnabled,
    serverUrl,
  };
}

/** Assembles the attrs persisted on an agent integration's features, shared by every agent handler. */
export function buildRecordedIntegrationAttrs(params: {
  serverUrl: string;
  orgKey: string | undefined;
  contextAugmentation: ResolvedVortexSetup | null;
}): Record<string, IntegrationStateAttribute> {
  return params.contextAugmentation?.disposition.action === 'install'
    ? buildContextAugmentationAttrs(
        params.serverUrl,
        params.orgKey,
        params.contextAugmentation.scaEnabled === true,
      )
    : {};
}

export interface ApplyContextAugmentationToolIntegrationParams {
  auth: ResolvedAuth;
  binaryPath: string;
  projectRoot: string;
  projectKey: string | undefined;
  scaEnabled: boolean;
  console: Console;
}

export interface CagSubprocessResult {
  ok: boolean;
  failureMessage?: string;
  stdout: string;
  stderr: string;
}

interface CagSubprocessOptions {
  projectRoot: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export class CagStepFailedError extends Error {
  constructor(readonly result: CagSubprocessResult) {
    super(result.failureMessage ?? 'sonar-context-augmentation step failed');
  }
}

export async function runToolIntegrateCommand(
  p: ApplyContextAugmentationToolIntegrationParams,
): Promise<void> {
  const console = p.console;
  console.text('     Installing Vortex Context...');

  const initEnv = await buildContextAugmentationEnv({
    organization: p.auth.orgKey,
    projectKey: p.projectKey,
    serverUrl: p.auth.serverUrl,
    token: p.auth.token,
    workspaceDir: p.projectRoot,
  });

  await runCagStepOrThrow(
    `sonar-context-augmentation ${SONAR_CONTEXT_AUGMENTATION_VERSION}`,
    'Vortex Context tool integration failed.',
    p.binaryPath,
    ['tool', 'integrate', '--invocation-prefix', SONAR_CONTEXT_INVOCATION],
    p.projectRoot,
    console,
    initEnv,
    INTEGRATE_TIMEOUT_MS,
  );
  console.discreetSuccess('Vortex Context configured');
}

export interface PrintContextAugmentationSkillParams {
  binaryPath: string;
  projectRoot: string;
  scaEnabled: boolean;
  console: Console;
  orgKey?: string;
}

const PRINT_SKILL_FAILURE_MESSAGE = 'Vortex Context skill generation failed.';

export async function printContextAugmentationSkill({
  binaryPath,
  projectRoot,
  scaEnabled,
  console,
  orgKey,
}: PrintContextAugmentationSkillParams): Promise<string> {
  const result = await runCagSubprocess(
    binaryPath,
    [
      'tool',
      'print-skill',
      '--invocation-prefix',
      SONAR_CONTEXT_INVOCATION,
      `--sca-enabled=${scaEnabled ? 'true' : 'false'}`,
    ],
    {
      projectRoot,
      env: await buildContextAugmentationEnv({ organization: orgKey }),
    },
  );
  if (!result.ok) {
    reportCagFailure(result, console);
    throw new CommandFailedError(PRINT_SKILL_FAILURE_MESSAGE);
  }
  if (result.stdout.trim().length === 0) {
    reportCagFailure(
      {
        ...result,
        ok: false,
        failureMessage: 'sonar-context-augmentation tool print-skill produced empty output',
      },
      console,
    );
    throw new CommandFailedError(PRINT_SKILL_FAILURE_MESSAGE);
  }
  return result.stdout;
}

export interface PrintSessionStartContextParams {
  binaryPath: string;
  scaEnabled: boolean;
  context: ContextAugmentationEnvContext; // `workspaceDir` is required here
}

/** Renders the condensed Vortex skill injected as `additionalContext` at agent session start. */
export async function printSessionStartContext(
  p: PrintSessionStartContextParams,
): Promise<CagSubprocessResult> {
  return runCagSubprocess(
    p.binaryPath,
    ['tool', 'print-session-start-context', `--sca-enabled=${p.scaEnabled ? 'true' : 'false'}`],
    { projectRoot: p.context.workspaceDir!, env: await buildContextAugmentationEnv(p.context) },
  );
}

/**
 * Best-effort `sonar-context-augmentation tool stop --all` invocation.
 * Used during declarative upgrade reconciliation before replacing the CAG
 * binary so refreshed skill content takes effect on next start.
 */
export async function stopAllContextAugmentationTools(binaryPath: string): Promise<boolean> {
  const result = await runCagSubprocess(binaryPath, ['tool', 'stop', '--all'], {
    projectRoot: process.cwd(),
  });
  if (!result.ok) {
    logger.debug(
      `sonar-context-augmentation tool stop --all failed: ${result.failureMessage ?? 'unknown error'}`,
    );
    return false;
  }
  return true;
}

async function runCagStepOrThrow(
  successMessage: string,
  failureMessage: string,
  binaryPath: string,
  args: string[],
  projectRoot: string,
  console: Console,
  env?: NodeJS.ProcessEnv,
  timeoutMs?: number,
): Promise<void> {
  if (process.stdout.isTTY) {
    try {
      await console.withSpinner(successMessage, async () => {
        const result = await runCagSubprocess(binaryPath, args, {
          projectRoot,
          env,
          timeoutMs,
        });
        if (!result.ok) {
          throw new CagStepFailedError(result);
        }
      });
    } catch (error) {
      reportCagFailureFromError(error, console);
      throw new CommandFailedError(failureMessage, {
        cause: error instanceof Error ? error : undefined,
      });
    }
    return;
  }

  const result = await runCagSubprocess(binaryPath, args, {
    projectRoot,
    env,
    timeoutMs,
  });
  if (!result.ok) {
    reportCagFailure(result, console);
    throw new CommandFailedError(failureMessage);
  }
  console.discreetSuccess(successMessage);
}

async function runCagSubprocess(
  binaryPath: string,
  args: string[],
  options: CagSubprocessOptions,
): Promise<CagSubprocessResult> {
  const env = options.env ?? (await buildContextAugmentationEnv());
  const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
  try {
    const result = await spawnProcessWithTimeout(
      binaryPath,
      args,
      {
        cwd: options.projectRoot,
        env,
        // The env already dropped inherited SONAR_CONTEXT_* keys. Merging process.env would restore them.
        isolateEnv: true,
        stdin: 'inherit',
        stdout: 'pipe',
        stderr: 'pipe',
        // Session-start context is injected with its trailing newline.
        trimOutput: false,
      },
      timeoutMs,
      `sonar-context-augmentation timed out after ${timeoutMs}ms`,
    );
    if (result.exitCode !== 0) {
      const termination = result.signal
        ? `signal ${result.signal}`
        : result.exitCode === null
          ? 'an unknown signal'
          : `code ${result.exitCode}`;
      return {
        ok: false,
        failureMessage: `sonar-context-augmentation exited with ${termination}.`,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const message =
      error instanceof ProcessTimedOutError
        ? error.message
        : `sonar-context-augmentation failed to start: ${(error as Error).message}`;
    return { ok: false, failureMessage: message, stdout: '', stderr: '' };
  }
}

function reportCagFailure(result: CagSubprocessResult, console: Console): void {
  if (result.failureMessage) {
    console.warn(result.failureMessage);
  }
  printIndented(result.stdout, 'stdout', console);
  printIndented(result.stderr, 'stderr', console);
}

function reportCagFailureFromError(error: unknown, console: Console): void {
  if (error instanceof CagStepFailedError) {
    reportCagFailure(error.result, console);
    return;
  }
  console.warn((error as Error).message);
}

function printIndented(buffer: string, channel: OutputChannel, console: Console): void {
  if (buffer.length === 0) {
    return;
  }
  const trimmed = buffer.endsWith('\n') ? buffer.slice(0, -1) : buffer;
  for (const line of trimmed.split('\n')) {
    console.print(`  ${line}`, channel);
  }
}
