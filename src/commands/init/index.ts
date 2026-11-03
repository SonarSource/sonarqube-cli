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

import type { InitOutcome } from './init-outcome.ts';
import { renderInitOutcome } from './output.ts';
import { resolveInitAuth } from './steps/auth.ts';
import { runBoundNew } from './steps/bind.ts';
import { type DetectDeps, detectInitPath, resolveProjectRoot } from './steps/detect.ts';
import { offerIntegrate } from './steps/integrate.ts';
import { runLinkExisting } from './steps/link-existing.ts';

export interface InitOptions {
  path?: string;
  nonInteractive?: boolean;
}

/**
 * Signs in, resolves the organization, detects the project and selects the onboarding path.
 * It runs `bound-new` and `link-existing` and only reports the other paths. It keeps everything it completed:
 * running it again resumes from whatever is already in place.
 */
export async function init(options: InitOptions, ctx: CommandInvocationContext): Promise<void> {
  const interactive = !options.nonInteractive && ctx.console.canPrompt();

  const projectRoot = resolveProjectRoot(options.path ?? '.');

  const { outcome, auth } = await run(projectRoot, ctx, interactive);
  const suggestIntegrate = findInstalledIntegrationIds().length === 0;
  // const suggestIntegrate = true;
  renderInitOutcome(outcome, ctx.console, { suggestIntegrate: suggestIntegrate && !interactive });
  if (suggestIntegrate && interactive) {
    await offerIntegrate(ctx, auth);
  }
}

async function run(
  projectRoot: string,
  ctx: CommandInvocationContext,
  interactive: boolean,
): Promise<{ outcome: InitOutcome; auth: ResolvedAuth }> {
  const auth = await resolveInitAuth(ctx, interactive);
  const deps = { auth, console: ctx.console, interactive };
  return { outcome: await runDetectedPath(await detectInitPath(projectRoot, deps), deps), auth };
}

function runDetectedPath(outcome: InitOutcome, deps: DetectDeps): Promise<InitOutcome> {
  switch (outcome.path) {
    case 'bound-new':
      return runBoundNew(outcome, deps);
    case 'link-existing':
      return runLinkExisting(outcome, deps);
    case 'complete':
    case 'unbound-new':
      return Promise.resolve(outcome);
  }
}
