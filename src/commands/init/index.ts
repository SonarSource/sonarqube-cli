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

import {
  type UnboundNewFlags,
  validateScanFlags,
  validateUnboundNewFlags,
  warnIgnoredScanFlags,
  warnIgnoredUnboundNewFlags,
} from './flags.ts';
import type { InitOutcome } from './init-outcome.ts';
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
  type ScanFlags,
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
  const flags = validateUnboundNewFlags(options);
  const scanFlags = validateScanFlags(options);

  const { outcome, auth, deps } = await run(projectRoot, ctx, console, interactive, flags);
  if (outcome.path !== 'unbound-new') {
    warnIgnoredUnboundNewFlags(flags, console);
  }
  const scan = await scanCreatedProject(outcome, deps, scanFlags);
  if (scan.status === 'not-run') {
    warnIgnoredScanFlags(scanFlags, console);
  }
  const declined = outcome.path === 'unbound-new' && outcome.declined === true;
  const suggestIntegrate = findInstalledIntegrationIds().length === 0;
  renderInitOutcome(outcome, auth, console, {
    suggestIntegrate: suggestIntegrate && (declined || !interactive),
  });
  if (suggestIntegrate && interactive && !declined) {
    await offerIntegrate(ctx, auth);
  }
}

/** Only a project this run created or found on the server unbound gets a first analysis. */
async function scanCreatedProject(
  outcome: InitOutcome,
  deps: DetectDeps,
  flags: ScanFlags,
): Promise<ScanResult> {
  if (outcome.path !== 'unbound-new' || !outcome.projectKey) {
    return NOT_RUN;
  }
  const scan = await runFirstScan(outcome.projectRoot, outcome.projectKey, deps, flags);
  reportScan(scan, outcome.projectKey, deps.console);
  return scan;
}

async function run(
  projectRoot: string,
  ctx: CommandInvocationContext,
  console: Console,
  interactive: boolean,
  flags: UnboundNewFlags,
): Promise<{ outcome: InitOutcome; auth: ResolvedAuth; deps: DetectDeps }> {
  const auth = await resolveInitAuth(ctx, interactive);
  const http = new SonarHttpClient(auth.serverUrl, auth.token);
  const deps: DetectDeps = { auth, http, console, interactive };
  const detected = await detectInitPath(projectRoot, deps);
  return { outcome: await runDetectedPath(detected, deps, flags), auth, deps };
}

/**
 * `bound-new` and `link-existing` hand back `unbound-new` only when the user declined binding or
 * linking, so it continues into the project creation.
 */
async function runDetectedPath(
  outcome: InitOutcome,
  deps: DetectDeps,
  flags: UnboundNewFlags,
): Promise<InitOutcome> {
  switch (outcome.path) {
    case 'bound-new':
      return fallBack(await runBoundNew(outcome, deps), deps, flags);
    case 'link-existing':
      return fallBack(await runLinkExisting(outcome, deps), deps, flags);
    case 'unbound-new':
      return runUnboundNew(outcome, deps, flags);
    case 'complete':
      return outcome;
  }
}

function fallBack(
  outcome: InitOutcome,
  deps: DetectDeps,
  flags: UnboundNewFlags,
): InitOutcome | Promise<InitOutcome> {
  return outcome.path === 'unbound-new' ? runUnboundNew(outcome, deps, flags) : outcome;
}
