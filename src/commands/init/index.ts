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
import type { Console } from '@/core/ui/console.ts';

import type { InitOutcome } from './init-outcome.ts';
import { renderInitOutcome } from './output.ts';
import { validateProjectKey, validateProjectName, validateVisibility } from './project-key.ts';
import { resolveInitAuth } from './steps/auth.ts';
import { runBoundNew } from './steps/bind.ts';
import { type DetectDeps, detectInitPath, resolveProjectRoot } from './steps/detect.ts';
import { offerIntegrate } from './steps/integrate.ts';
import { runLinkExisting } from './steps/link-existing.ts';
import { runUnboundNew, type UnboundNewFlags } from './steps/unbound.ts';

export interface InitOptions {
  path?: string;
  nonInteractive?: boolean;
  projectKey?: string;
  name?: string;
  visibility?: string;
}

function validateFlags(options: InitOptions): UnboundNewFlags {
  return {
    projectKey:
      options.projectKey === undefined ? undefined : validateProjectKey(options.projectKey),
    name: options.name === undefined ? undefined : validateProjectName(options.name),
    visibility:
      options.visibility === undefined ? undefined : validateVisibility(options.visibility),
  };
}

function warnIgnoredFlags(flags: UnboundNewFlags, console: Console): void {
  const ignored = [
    flags.projectKey === undefined ? null : '--project-key',
    flags.name === undefined ? null : '--name',
    flags.visibility === undefined ? null : '--visibility',
  ].filter((flag) => flag !== null);
  if (ignored.length > 0) {
    console.warn(
      `${ignored.join(', ')} ignored: they only apply when a new project is created without repository binding.`,
    );
  }
}

/**
 * Signs in, resolves the organization, detects the project and selects the onboarding path.
 * It runs `bound-new`, `link-existing` and `unbound-new`. It keeps everything it completed:
 * running it again resumes from whatever is already in place.
 */
export async function init(options: InitOptions, ctx: CommandInvocationContext): Promise<void> {
  const interactive = !options.nonInteractive && ctx.console.canPrompt();

  const projectRoot = resolveProjectRoot(options.path ?? '.');
  const flags = validateFlags(options);

  const { outcome, auth } = await run(projectRoot, ctx, interactive, flags);
  if (outcome.path !== 'unbound-new') {
    warnIgnoredFlags(flags, ctx.console);
  }
  const declined = outcome.path === 'unbound-new' && outcome.declined === true;
  const suggestIntegrate = findInstalledIntegrationIds().length === 0;
  renderInitOutcome(outcome, ctx.console, {
    suggestIntegrate: declined || (suggestIntegrate && !interactive),
  });
  if (suggestIntegrate && interactive && !declined) {
    await offerIntegrate(ctx, auth);
  }
}

async function run(
  projectRoot: string,
  ctx: CommandInvocationContext,
  interactive: boolean,
  flags: UnboundNewFlags,
): Promise<{ outcome: InitOutcome; auth: ResolvedAuth }> {
  const auth = await resolveInitAuth(ctx, interactive);
  const deps = { auth, console: ctx.console, interactive };
  const detected = await detectInitPath(projectRoot, deps);
  return { outcome: await runDetectedPath(detected, deps, flags), auth };
}

/** A path that falls back to `unbound-new` (declined binding or linking) continues into it. */
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

function fallBack(outcome: InitOutcome, deps: DetectDeps, flags: UnboundNewFlags) {
  return outcome.path === 'unbound-new' && !outcome.projectKey && !outcome.declined
    ? runUnboundNew(outcome, deps, flags)
    : outcome;
}
