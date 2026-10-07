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

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { CommandFailedError, InvalidOptionError } from '@/core/commands/command-error.ts';
import type { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';
import { installSonarScanner } from '@/core/host/install/sonar-scanner.ts';
import { discoverProject } from '@/core/project-info.ts';
import { isSonarQubeCloud } from '@/core/server/sonarcloud-region.ts';
import { noteProject } from '@/core/telemetry/project-uuid.ts';

import { OnboardApiClient } from './onboard-api.ts';
import { generateProjectTarget } from './project-key.ts';
import { runFirstAnalysis } from './scanner.ts';
import { scannerNetworkEnv } from './scanner-network.ts';

export interface OnboardOptions {
  projectKey?: string;
}

function validateProjectKey(key: string): string {
  if (!key || !/^[a-zA-Z0-9._:-]+$/.test(key) || /^\d+$/.test(key)) {
    throw new InvalidOptionError(
      '--project-key must contain only letters, digits, ".", "_", "-", or ":" and cannot be entirely numeric.',
    );
  }
  return key;
}

function assertSupportedBuild(projectRoot: string): void {
  const files = readdirSync(projectRoot);
  let scanner: string | undefined;
  if (existsSync(join(projectRoot, 'pom.xml'))) scanner = 'Maven';
  else if (
    files.some((name) =>
      ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'].includes(name),
    )
  )
    scanner = 'Gradle';
  else if (files.some((name) => /\.(slnx?|csproj|vbproj|fsproj)$/i.test(name))) scanner = '.NET';
  if (scanner)
    throw new CommandFailedError(`This project requires SonarScanner for ${scanner}.`, {
      remediationHint: `Use the dedicated SonarScanner for ${scanner} to create its first analysis.`,
    });
}

async function resolveTarget(
  options: OnboardOptions,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<{ projectKey: string; projectRoot: string; projectName: string }> {
  if (options.projectKey !== undefined)
    return {
      projectKey: validateProjectKey(options.projectKey),
      projectRoot: process.cwd(),
      projectName: basename(process.cwd()),
    };
  const project = await discoverProject(process.cwd(), {
    auth: null,
    useKnownMappings: false,
    silent: true,
    console: ctx.console,
  });
  if (!project.projectKey) {
    const target = await generateProjectTarget(
      project.projectRoot,
      project.repoRoot,
      ctx.auth.orgKey,
    );
    ctx.console.info(`Generated project key '${target.projectKey}' for '${target.projectName}'.`);
    return target;
  }
  if (
    (project.serverUrl &&
      project.serverUrl.replace(/\/$/, '') !== ctx.auth.serverUrl.replace(/\/$/, '')) ||
    (project.organization && project.organization !== ctx.auth.orgKey)
  ) {
    throw new CommandFailedError(
      'The detected project configuration does not match the active connection.',
      {
        remediationHint:
          'Log in to the matching server and organization, or supply --project-key explicitly.',
      },
    );
  }
  ctx.console.info(`Using project key '${project.projectKey}' from project configuration.`);
  return {
    projectKey: validateProjectKey(project.projectKey),
    projectRoot: project.projectRoot,
    projectName: basename(project.projectRoot),
  };
}

export async function onboard(
  options: OnboardOptions,
  ctx: CommandAuthenticatedInvocationContext,
): Promise<void> {
  const { auth, console } = ctx;
  const { projectKey, projectRoot, projectName } = await resolveTarget(options, ctx);
  if ((auth.connectionType === 'cloud' || isSonarQubeCloud(auth.serverUrl)) && !auth.orgKey) {
    throw new CommandFailedError('A SonarQube Cloud organization is required for onboarding.', {
      remediationHint: 'Run sonar auth login --org <organization> first.',
    });
  }
  assertSupportedBuild(projectRoot);
  const api = new OnboardApiClient(ctx.connection.httpClient);
  if (await api.components.componentExists(projectKey).orThrow())
    throw new CommandFailedError(
      `Project '${projectKey}' already exists. Onboarding creates a new project.`,
      { remediationHint: 'Choose a different --project-key to create another project.' },
    );

  const scanner = await installSonarScanner(console);
  const directory = mkdtempSync(join(tmpdir(), 'sonar-onboard-'));
  const dashboard = `${auth.serverUrl.replace(/\/$/, '')}/dashboard?id=${encodeURIComponent(projectKey)}`;
  let created = false;
  try {
    const networkEnv = await scannerNetworkEnv(auth.serverUrl, scanner.javaPath, directory);
    await api.createProject(projectKey, projectName, auth.orgKey).orThrow();
    created = true;
    noteProject(auth, projectKey);
    console.success(`Created private unbound project '${projectKey}'.`);
    const taskId = await runFirstAnalysis(
      scanner,
      projectRoot,
      projectKey,
      auth,
      directory,
      networkEnv,
      console,
    );
    console.success('Analysis uploaded.');
    const analysisId = await console.withSpinner('Waiting for analysis processing', () =>
      api.waitForAnalysis(taskId, projectKey),
    );
    const gate = await api.qualityGate(analysisId);
    console.success('Analysis processed.');
    console.text(`Quality gate: ${gate}`);
    console.text(`Results: ${dashboard}`);
  } catch (cause) {
    if (!created) throw cause;
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new CommandFailedError(
      `Project '${projectKey}' was created, but its first analysis could not be completed: ${message}`,
      {
        cause,
        remediationHint: `The project and scanner installation have been retained. Check ${dashboard} and rerun the scanner from ${scanner.home} after resolving the error.`,
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
