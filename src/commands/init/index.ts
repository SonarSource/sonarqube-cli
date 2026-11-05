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

import { findInstalledIntegrationIds } from '@/commands/integrate/_common/installed-integrations.ts';
import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { SonarHttpClient } from '@/core/server/http-client.ts';
import type { Console } from '@/core/ui/console.ts';

import type { InitOutcome, InitPath, UnboundNewPath } from './init-outcome.ts';
import {
  type UnboundNewOptions,
  validateScanOptions,
  validateUnboundNewOptions,
  warnIgnoredScanOptions,
  warnIgnoredUnboundNewOptions,
} from './options.ts';
import { renderInitOutcome } from './output.ts';
import { resolveInitAuth } from './steps/auth.ts';
import { runBoundNew } from './steps/bind.ts';
import { type DetectDeps, detectInitPath, resolveProjectRoot } from './steps/detect.ts';
import { offerIntegrate } from './steps/integrate.ts';
import { runLinkExisting } from './steps/link-existing.ts';
import {
  NOT_RUN,
  reportScan,
  runFirstScan,
  type ScanOptions,
  type ScanResult,
} from './steps/scan.ts';
import { runUnboundNew } from './steps/unbound.ts';

export interface InitOptions {
  path?: string;
  nonInteractive?: boolean;
  project?: string;
  name?: string;
  visibility?: string;
  scannerProperty?: string[];
  verbose?: boolean;
  detach?: boolean;
}

/**
 * Signs in, resolves the organization, detects the project and selects the onboarding path.
 * It runs `bound-new`, `link-existing` and `unbound-new`. It keeps everything it completed:
 * running it again resumes from whatever is already in place.
 */
export async function init(options: InitOptions, ctx: CommandInvocationContext): Promise<void> {
  const interactive = !options.nonInteractive && ctx.console.canPrompt();
  const { console } = ctx;

  const projectRoot = resolveProjectRoot(options.path ?? '.');
  const unboundNewOptions = validateUnboundNewOptions(options);
  const scanOptions = validateScanOptions(options);

  const { outcome, auth, deps } = await run(
    projectRoot,
    ctx,
    console,
    interactive,
    unboundNewOptions,
  );
  if (outcome.kind !== 'unbound' && outcome.kind !== 'declined') {
    warnIgnoredUnboundNewOptions(unboundNewOptions, console);
  }
  const scan = await scanCreatedProject(outcome, projectRoot, deps, scanOptions);
  if (scan.status === 'not-run') {
    warnIgnoredScanOptions(scanOptions, console);
  }
  const declined = outcome.kind === 'declined';
  const suggestIntegrate = findInstalledIntegrationIds().length === 0;
  renderInitOutcome(outcome, console, {
    suggestIntegrate: suggestIntegrate && (declined || !interactive),
  });
  if (suggestIntegrate && interactive && !declined) {
    await offerIntegrate(ctx, auth);
  }
}

/** Only a project this run created or found on the server unbound gets a first analysis. */
async function scanCreatedProject(
  outcome: InitOutcome,
  projectRoot: string,
  deps: DetectDeps,
  options: ScanOptions,
): Promise<ScanResult> {
  if (outcome.kind !== 'unbound') {
    return NOT_RUN;
  }
  const scan = await runFirstScan(projectRoot, outcome.projectKey, deps, options);
  reportScan(scan, outcome.projectKey, deps, deps.console);
  return scan;
}

async function run(
  projectRoot: string,
  ctx: CommandInvocationContext,
  console: Console,
  interactive: boolean,
  unboundNewOptions: UnboundNewOptions,
): Promise<{ outcome: InitOutcome; auth: ResolvedAuth; deps: DetectDeps }> {
  const auth = await resolveInitAuth(ctx, interactive);
  const http = new SonarHttpClient(auth.serverUrl, auth.token);
  const deps: DetectDeps = { auth, http, console, interactive };
  const detected = await detectInitPath(projectRoot, deps);
  return { outcome: await runDetectedPath(detected, deps, unboundNewOptions), auth, deps };
}

/**
 * `bound-new` and `link-existing` hand back `unbound-new` only when the user declined binding or
 * linking, so it continues into the project creation.
 */
async function runDetectedPath(
  detected: InitPath,
  deps: DetectDeps,
  unboundNewOptions: UnboundNewOptions,
): Promise<InitOutcome> {
  switch (detected.path) {
    case 'bound-new':
      return fallBack(await runBoundNew(detected, deps), deps, unboundNewOptions);
    case 'link-existing':
      return fallBack(await runLinkExisting(detected, deps), deps, unboundNewOptions);
    case 'unbound-new':
      return runUnboundNew(detected, deps, unboundNewOptions);
    case 'complete':
      return { kind: 'complete', projectKeys: detected.projectKeys };
  }
}

function fallBack(
  result: InitOutcome | UnboundNewPath,
  deps: DetectDeps,
  unboundNewOptions: UnboundNewOptions,
): InitOutcome | Promise<InitOutcome> {
  return 'kind' in result ? result : runUnboundNew(result, deps, unboundNewOptions);
}
