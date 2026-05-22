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

import { version as VERSION } from '../../../../../package.json';
import type { ResolvedAuth } from '../../../../lib/auth-resolver';
import { isSonarQubeCloud } from '../../../../lib/auth-resolver';
import { SONAR_CONTEXT_INVOCATION } from '../../../../lib/config-constants';
import logger from '../../../../lib/logger';
import { SONAR_CONTEXT_AUGMENTATION_VERSION } from '../../../../lib/signatures';
import { recordSkillExtensionInState } from '../../../../lib/state-manager';
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
import { installContextAugmentationBinary } from '../../_common/install/context-augmentation';

export type ContextAugmentationAgent = 'claude-code' | 'copilot';

export interface SetupContextAugmentationParams {
  auth: ResolvedAuth;
  agent: ContextAugmentationAgent;
  projectRoot: string;
  projectKey: string | undefined;
  isGlobal: boolean;
}

// Maps the CAG subprocess agent argument to the internal state agent id.
// The CAG argument ('copilot') differs from the Copilot state id ('copilot-cli').
const STATE_AGENT_ID: Record<ContextAugmentationAgent, string> = {
  'claude-code': 'claude-code',
  copilot: 'copilot-cli',
};

// Inverse lookup for state entries, which store agent ids rather than CAG subcommand arguments.
const CAG_AGENT_BY_STATE_AGENT_ID: Record<string, ContextAugmentationAgent> = Object.fromEntries(
  Object.entries(STATE_AGENT_ID).map(([agent, stateAgentId]) => [
    stateAgentId,
    agent as ContextAugmentationAgent,
  ]),
);

export function resolveContextAugmentationAgent(
  agentId: string,
): ContextAugmentationAgent | undefined {
  return CAG_AGENT_BY_STATE_AGENT_ID[agentId];
}

export async function setupContextAugmentation(p: SetupContextAugmentationParams): Promise<void> {
  blank();
  info('Setting up SonarQube Context Augmentation...');

  const isCloud = isSonarQubeCloud(p.auth.serverUrl);
  if (!isCloud) {
    text('Skipping Context Augmentation: not available on SonarQube Server.');
    return;
  }

  if (p.isGlobal) {
    warn(
      'Skipping Context Augmentation: not supported with --global. Re-run without --global from a project directory to install it there.',
    );
    return;
  }

  if (!p.projectKey || !p.auth.orgKey) {
    warn(
      'Skipping Context Augmentation: a project key and organization are required (configure your project or pass --project).',
    );
    return;
  }

  const client = new SonarQubeClient(p.auth.serverUrl, p.auth.token);
  const entitlement = await client.hasCagEntitlement(p.auth.orgKey);
  if (entitlement === 'check_failed') {
    warn(
      'Skipping Context Augmentation: could not verify entitlement (server unreachable or returned an error).',
    );
    return;
  }
  if (entitlement === 'not_enabled') {
    warn(
      'Skipping Context Augmentation: not enabled for your organization. Enable it in your SonarQube Cloud organization settings.',
    );
    return;
  }

  const scaStatus = await client.getScaEnablement(p.auth.connectionType, p.auth.orgKey);
  if (scaStatus === 'check_failed') {
    warn(
      'Could not verify SCA availability on the connected server. Proceeding with --sca-enabled=false.',
    );
  }
  const scaEnabled = scaStatus === 'enabled';

  let binaryPath: string;
  try {
    binaryPath = await installContextAugmentationBinary();
  } catch (err) {
    warn(`Failed to install sonar-context-augmentation: ${(err as Error).message}`);
    return;
  }

  const initEnv = buildContextAugmentationEnv({
    organization: p.auth.orgKey,
    projectKey: p.projectKey,
    serverUrl: p.auth.serverUrl,
    token: p.auth.token,
  });

  const initOk = await runCagStep(
    `sonar-context-augmentation ${SONAR_CONTEXT_AUGMENTATION_VERSION}`,
    binaryPath,
    [
      'tool',
      'integrate',
      '--agent',
      p.agent,
      '--invocation-prefix',
      SONAR_CONTEXT_INVOCATION,
      `--sca-enabled=${scaEnabled ? 'true' : 'false'}`,
    ],
    p,
    initEnv,
  );
  if (!initOk) {
    warn('Context Augmentation init failed (see output above). Skipping skill installation.');
    return;
  }

  recordSkillExtensionInState({
    agentId: STATE_AGENT_ID[p.agent],
    projectRoot: p.projectRoot,
    global: false,
    projectKey: p.projectKey,
    orgKey: p.auth.orgKey,
    serverUrl: p.auth.serverUrl,
    updatedByCliVersion: VERSION,
    name: 'sonar-context-augmentation',
    version: SONAR_CONTEXT_AUGMENTATION_VERSION,
    scaEnabled,
  });
  success('SonarQube Context Augmentation configured');
}

interface CagSubprocessResult {
  ok: boolean;
  failureMessage?: string;
  stdout: string;
  stderr: string;
}

interface CagSubprocessOptions {
  projectRoot: string;
  env?: NodeJS.ProcessEnv;
}

export interface InstallContextAugmentationSkillParams {
  binaryPath: string;
  agent: ContextAugmentationAgent;
  projectRoot: string;
  scaEnabled: boolean;
  reportFailure?: boolean;
}

class CagStepFailedError extends Error {
  constructor(readonly result: CagSubprocessResult) {
    super('sonar-context-augmentation step failed');
  }
}

export async function installContextAugmentationSkill({
  binaryPath,
  agent,
  projectRoot,
  scaEnabled,
  reportFailure = true,
}: InstallContextAugmentationSkillParams): Promise<boolean> {
  const result = await runCagSubprocess(binaryPath, buildSkillInstallArgs(agent, scaEnabled), {
    projectRoot,
  });
  if (!result.ok) {
    if (reportFailure) {
      reportCagFailure(result);
    }
    return false;
  }
  return true;
}

/**
 * Best-effort `sonar-context-augmentation tool stop --all` invocation.
 * Used during post-update to stop running CAG tools before refreshing skills
 * so the refreshed skill templates take effect on next start. Failures are
 * logged at debug level and never surfaced to the user.
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

function buildSkillInstallArgs(agent: ContextAugmentationAgent, scaEnabled: boolean): string[] {
  return [
    'tool',
    'install-skill',
    agent,
    '--invocation-prefix',
    SONAR_CONTEXT_INVOCATION,
    `--sca-enabled=${scaEnabled ? 'true' : 'false'}`,
  ];
}

async function runCagStep(
  successMessage: string,
  binaryPath: string,
  args: string[],
  p: SetupContextAugmentationParams,
  env: NodeJS.ProcessEnv = buildContextAugmentationEnv(),
): Promise<boolean> {
  if (process.stdout.isTTY) {
    try {
      await withSpinner(successMessage, async () => {
        const result = await runCagSubprocess(binaryPath, args, {
          projectRoot: p.projectRoot,
          env,
        });
        if (!result.ok) {
          throw new CagStepFailedError(result);
        }
      });
      return true;
    } catch (err) {
      if (err instanceof CagStepFailedError) {
        reportCagFailure(err.result);
        return false;
      }
      throw err;
    }
  }

  const result = await runCagSubprocess(binaryPath, args, {
    projectRoot: p.projectRoot,
    env,
  });
  if (!result.ok) {
    reportCagFailure(result);
    return false;
  }
  discreetSuccess(successMessage);
  return true;
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
    } catch (err) {
      // Some platforms (notably Windows when the binary is not a valid PE)
      // surface spawn failures synchronously rather than via the 'error' event.
      // Preserve the warn-on-failure contract by handling both shapes.
      resolve({
        ok: false,
        failureMessage: `sonar-context-augmentation failed to start: ${(err as Error).message}`,
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

    child.on('error', (err) => {
      resolve({
        ok: false,
        failureMessage: `sonar-context-augmentation failed to start: ${err.message}`,
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

function printIndented(buffer: string, target: NodeJS.WriteStream): void {
  if (buffer.length === 0) return;
  const trimmed = buffer.endsWith('\n') ? buffer.slice(0, -1) : buffer;
  for (const line of trimmed.split('\n')) {
    print(`  ${line}`, target);
  }
}
