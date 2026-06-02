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
import { randomUUID } from 'node:crypto';

import { version as VERSION } from '../../../../../package.json';
import type { ResolvedAuth } from '../../../../lib/auth-resolver';
import { isSonarQubeCloud } from '../../../../lib/auth-resolver';
import { SONAR_CONTEXT_INVOCATION } from '../../../../lib/config-constants';
import { CONTEXT_AUGMENTATION_BINARY_NAME } from '../../../../lib/install-types';
import logger from '../../../../lib/logger';
import { SONAR_CONTEXT_AUGMENTATION_VERSION } from '../../../../lib/signatures';
import type { CliState } from '../../../../lib/state';
import { upsertAgentExtension } from '../../../../lib/state-manager';
import { SonarQubeClient } from '../../../../sonarqube/client';
import {
  blank,
  discreetSuccess,
  info,
  print,
  success,
  text,
  warn,
  withSpinner,
} from '../../../../ui';
import { buildContextAugmentationEnv } from '../../_common/context-augmentation-env';
import { CommandFailedError } from '../../_common/error';

export const CONTEXT_AUGMENTATION_SKILL_STATE_NAME = CONTEXT_AUGMENTATION_BINARY_NAME;

export type ContextAugmentationAgentId = 'claude-code' | 'copilot-cli' | 'codex';

export interface ResolveContextAugmentationSetupParams {
  auth: ResolvedAuth;
  projectKey: string | undefined;
  isGlobal: boolean;
}

export interface ResolvedContextAugmentationSetup {
  scaEnabled: boolean;
}

export interface ApplyContextAugmentationToolIntegrationParams {
  state: CliState;
  agentId: ContextAugmentationAgentId;
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
    super('sonar-context-augmentation step failed');
  }
}

export async function resolveContextAugmentationSetup(
  p: ResolveContextAugmentationSetupParams,
): Promise<ResolvedContextAugmentationSetup | null> {
  const isCloud = isSonarQubeCloud(p.auth.serverUrl);
  if (!isCloud) {
    text('Skipping Context Augmentation: not available on SonarQube Server.');
    return null;
  }

  if (p.isGlobal) {
    warn(
      'Skipping Context Augmentation: not supported with --global. Re-run without --global from a project directory to install it there.',
    );
    return null;
  }

  if (!p.projectKey || !p.auth.orgKey) {
    warn(
      'Skipping Context Augmentation: a project key and organization are required (configure your project or pass --project).',
    );
    return null;
  }

  const client = new SonarQubeClient(p.auth.serverUrl, p.auth.token);
  const entitlement = await client.hasCagEntitlement(p.auth.orgKey);
  if (entitlement === 'check_failed') {
    warn(
      'Skipping Context Augmentation: could not verify entitlement (server unreachable or returned an error).',
    );
    return null;
  }
  if (entitlement === 'not_enabled') {
    warn(
      'Skipping Context Augmentation: not enabled for your organization. Enable it in your SonarQube Cloud organization settings.',
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
  blank();
  info('Setting up SonarQube Context Augmentation...');

  const initEnv = buildContextAugmentationEnv({
    organization: p.auth.orgKey,
    projectKey: p.projectKey,
    serverUrl: p.auth.serverUrl,
    token: p.auth.token,
  });

  await runCagStepOrThrow(
    `sonar-context-augmentation ${SONAR_CONTEXT_AUGMENTATION_VERSION}`,
    'Context Augmentation tool integration failed.',
    p.binaryPath,
    ['tool', 'integrate', '--invocation-prefix', SONAR_CONTEXT_INVOCATION],
    p.projectRoot,
    initEnv,
  );

  upsertAgentExtension(p.state, {
    id: randomUUID(),
    kind: 'skill',
    agentId: p.agentId,
    projectRoot: p.projectRoot,
    global: false,
    projectKey: p.projectKey,
    orgKey: p.auth.orgKey,
    serverUrl: p.auth.serverUrl,
    updatedByCliVersion: VERSION,
    updatedAt: new Date().toISOString(),
    name: CONTEXT_AUGMENTATION_SKILL_STATE_NAME,
    version: SONAR_CONTEXT_AUGMENTATION_VERSION,
    scaEnabled: p.scaEnabled,
  });
  success('SonarQube Context Augmentation configured');
}

export async function printContextAugmentationSkill({
  binaryPath,
  projectRoot,
  scaEnabled,
}: PrintContextAugmentationSkillParams): Promise<string> {
  const result = await runCagSubprocess(
    binaryPath,
    ['tool', 'print-skill', `--sca-enabled=${scaEnabled ? 'true' : 'false'}`],
    {
      projectRoot,
      env: buildContextAugmentationEnv({}),
    },
  );
  if (!result.ok) {
    throw new CagStepFailedError(result);
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
  printIndented(result.stdout, process.stdout);
  printIndented(result.stderr, process.stderr);
}

function reportCagFailureFromError(error: unknown): void {
  if (error instanceof CagStepFailedError) {
    reportCagFailure(error.result);
    return;
  }
  warn((error as Error).message);
}

function printIndented(buffer: string, target: NodeJS.WriteStream): void {
  if (buffer.length === 0) {
    return;
  }
  const trimmed = buffer.endsWith('\n') ? buffer.slice(0, -1) : buffer;
  for (const line of trimmed.split('\n')) {
    print(`  ${line}`, target);
  }
}
