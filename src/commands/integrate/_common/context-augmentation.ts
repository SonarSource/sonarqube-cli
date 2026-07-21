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

import type { ResolvedAuth } from '../../../lib/auth-resolver.ts';
import { isSonarQubeCloud } from '../../../lib/auth-resolver.ts';
import { SONAR_CONTEXT_INVOCATION } from '../../../lib/config-constants.ts';
import logger from '../../../lib/logger.ts';
import { resolveRecordedRepoRoot } from '../../../lib/project-workspace/git-worktree.ts';
import { SONAR_CONTEXT_AUGMENTATION_VERSION } from '../../../lib/signatures.ts';
import type { IntegrationStateAttribute } from '../../../lib/state.ts';
import { SonarQubeClient } from '../../../sonarqube/client.ts';
import { discreetSuccess, type OutputChannel, print, text, warn, withSpinner } from '../../../ui';
import { buildContextAugmentationEnv } from '../../_common/context-augmentation-env.ts';
import { CommandFailedError } from '../../_common/error.ts';

export interface ResolveContextAugmentationSetupParams {
  auth: ResolvedAuth;
  projectKey: string | undefined;
  isGlobal: boolean;
}

export interface ResolvedContextAugmentationSetup {
  scaEnabled: boolean;
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

/**
 * Assemble the attrs persisted on an agent integration's features, shared by
 * every agent handler. Records the repository's main working tree as `repoRoot`
 * (resolved once from `projectRoot`) so `sonar analyze`/`sonar context` can match
 * the integration from any linked worktree — including ones created after
 * integrate ran; falls back to `projectRoot` outside a git repo. Layers the
 * agent's `baseAttrs` first, then the Context Augmentation connection attrs when
 * CAG was set up.
 */
export async function buildRecordedIntegrationAttrs(params: {
  baseAttrs: Record<string, IntegrationStateAttribute>;
  projectRoot: string;
  serverUrl: string;
  orgKey: string | undefined;
  contextAugmentation: ResolvedContextAugmentationSetup | null;
}): Promise<Record<string, IntegrationStateAttribute>> {
  return {
    ...params.baseAttrs,
    repoRoot: await resolveRecordedRepoRoot(params.projectRoot),
    ...(params.contextAugmentation
      ? buildContextAugmentationAttrs(
          params.serverUrl,
          params.orgKey,
          params.contextAugmentation.scaEnabled,
        )
      : {}),
  };
}

export interface ApplyContextAugmentationToolIntegrationParams {
  auth: ResolvedAuth;
  binaryPath: string;
  projectRoot: string;
  projectKey: string | undefined;
  scaEnabled: boolean;
}

export interface PrintContextAugmentationSkillParams {
  binaryPath: string;
  projectRoot: string;
  scaEnabled: boolean;
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
}

export class CagStepFailedError extends Error {
  constructor(readonly result: CagSubprocessResult) {
    super(result.failureMessage ?? 'sonar-context-augmentation step failed');
  }
}

export async function resolveContextAugmentationSetup(
  p: ResolveContextAugmentationSetupParams,
): Promise<ResolvedContextAugmentationSetup | null> {
  const isCloud = isSonarQubeCloud(p.auth.serverUrl);
  if (!isCloud) {
    text('Skipping Vortex context augmentation: not available on SonarQube Server.');
    return null;
  }

  if (p.isGlobal) {
    // CAG is project-scoped, so a global install can never set it up. Only show
    // the skip notice to orgs that are actually entitled (avoids noise for orgs
    // that could not use CAG anyway).
    if (p.auth.orgKey) {
      const client = new SonarQubeClient(p.auth.serverUrl, p.auth.token);
      if ((await client.hasCagEntitlement(p.auth.orgKey)) === 'entitled') {
        warn(
          'Skipping Vortex context augmentation: not supported with --global. Re-run without --global from a project directory to install it there.',
        );
      }
    }
    return null;
  }

  if (!p.projectKey || !p.auth.orgKey) {
    warn(
      'Skipping Vortex context augmentation: a project key and organization are required (configure your project or pass --project).',
    );
    return null;
  }

  const client = new SonarQubeClient(p.auth.serverUrl, p.auth.token);
  const entitlement = await client.hasCagEntitlement(p.auth.orgKey);
  if (entitlement === 'check_failed') {
    warn(
      'Skipping Vortex context augmentation: could not verify entitlement (server unreachable or returned an error).',
    );
    return null;
  }
  if (entitlement === 'not_entitled') {
    warn(
      'Skipping Vortex context augmentation: not available for your organization. Access requires an eligible SonarQube Cloud plan.',
    );
    return null;
  }

  const scaStatus = await client.getScaEnablement(p.auth.connectionType, p.auth.orgKey);
  if (scaStatus === 'check_failed') {
    warn(
      'Could not verify SCA availability on the connected server. Proceeding with SCA disabled in the generated skill content.',
    );
  }

  return { scaEnabled: scaStatus === 'enabled' };
}

export async function runToolIntegrateCommand(
  p: ApplyContextAugmentationToolIntegrationParams,
): Promise<void> {
  text('     Installing Vortex context augmentation...');

  const initEnv = buildContextAugmentationEnv({
    organization: p.auth.orgKey,
    projectKey: p.projectKey,
    serverUrl: p.auth.serverUrl,
    token: p.auth.token,
    workspaceDir: p.projectRoot,
  });

  await runCagStepOrThrow(
    `sonar-context-augmentation ${SONAR_CONTEXT_AUGMENTATION_VERSION}`,
    'Vortex context augmentation tool integration failed.',
    p.binaryPath,
    ['tool', 'integrate', '--invocation-prefix', SONAR_CONTEXT_INVOCATION],
    p.projectRoot,
    initEnv,
  );
  discreetSuccess('Vortex context augmentation configured');
}

export async function printContextAugmentationSkill({
  binaryPath,
  projectRoot,
  scaEnabled,
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
      env: buildContextAugmentationEnv({}),
    },
  );
  if (!result.ok) {
    throw new CagStepFailedError(result);
  }
  if (result.stdout.trim().length === 0) {
    throw new CagStepFailedError({
      ...result,
      ok: false,
      failureMessage: 'sonar-context-augmentation tool print-skill produced empty output',
    });
  }
  return result.stdout;
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
  env: NodeJS.ProcessEnv = buildContextAugmentationEnv(),
): Promise<void> {
  if (process.stdout.isTTY) {
    try {
      await withSpinner(successMessage, async () => {
        const result = await runCagSubprocess(binaryPath, args, {
          projectRoot,
          env,
        });
        if (!result.ok) {
          throw new CagStepFailedError(result);
        }
      });
    } catch (error) {
      reportCagFailureFromError(error);
      throw new CommandFailedError(failureMessage, {
        cause: error instanceof Error ? error : undefined,
      });
    }
    return;
  }

  const result = await runCagSubprocess(binaryPath, args, {
    projectRoot,
    env,
  });
  if (!result.ok) {
    reportCagFailure(result);
    throw new CommandFailedError(failureMessage);
  }
  discreetSuccess(successMessage);
}

async function runCagSubprocess(
  binaryPath: string,
  args: string[],
  options: CagSubprocessOptions,
): Promise<CagSubprocessResult> {
  return new Promise<CagSubprocessResult>((resolve) => {
    let child;
    try {
      child = spawn(binaryPath, args, {
        cwd: options.projectRoot,
        stdio: ['inherit', 'pipe', 'pipe'],
        env: options.env ?? buildContextAugmentationEnv(),
      });
    } catch (error) {
      resolve({
        ok: false,
        failureMessage: `sonar-context-augmentation failed to start: ${(error as Error).message}`,
        stdout: '',
        stderr: '',
      });
      return;
    }

    let stdoutBuf = '';
    let stderrBuf = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBuf += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderrBuf += chunk;
    });

    child.on('error', (error) => {
      resolve({
        ok: false,
        failureMessage: `sonar-context-augmentation failed to start: ${error.message}`,
        stdout: stdoutBuf,
        stderr: stderrBuf,
      });
    });
    child.on('exit', (code, signal) => {
      if (code !== 0) {
        resolve({
          ok: false,
          failureMessage: `sonar-context-augmentation exited with ${
            code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`
          }.`,
          stdout: stdoutBuf,
          stderr: stderrBuf,
        });
        return;
      }
      resolve({ ok: true, stdout: stdoutBuf, stderr: stderrBuf });
    });
  });
}

function reportCagFailure(result: CagSubprocessResult): void {
  if (result.failureMessage) {
    warn(result.failureMessage);
  }
  printIndented(result.stdout, 'stdout');
  printIndented(result.stderr, 'stderr');
}

function reportCagFailureFromError(error: unknown): void {
  if (error instanceof CagStepFailedError) {
    reportCagFailure(error.result);
    return;
  }
  warn((error as Error).message);
}

function printIndented(buffer: string, channel: OutputChannel): void {
  if (buffer.length === 0) {
    return;
  }
  const trimmed = buffer.endsWith('\n') ? buffer.slice(0, -1) : buffer;
  for (const line of trimmed.split('\n')) {
    print(`  ${line}`, channel);
  }
}
