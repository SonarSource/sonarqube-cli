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

import { integrateBare } from '@/commands/integrate/integrate-bare.ts';
import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import type {
  CommandAuthenticatedInvocationContext,
  CommandInvocationContext,
} from '@/core/commands/invocation-context.ts';

export type IntegrateRunner = (ctx: CommandAuthenticatedInvocationContext) => Promise<void>;

/**
 * Asks whether to set up coding agents now and runs `sonar integrate` when accepted. Onboarding has already succeeded by then, so a failure or an abort
 * inside integrate is a warning and never changes the exit code.
 */
export async function offerIntegrate(
  ctx: CommandInvocationContext,
  auth: ResolvedAuth,
  runIntegrate: IntegrateRunner = (integrateCtx) => integrateBare(integrateCtx, {}),
): Promise<void> {
  const { console } = ctx;
  const accepted = await console.confirmPrompt(
    "Set up your coding agents with 'sonar integrate' now?",
    true,
  );
  if (accepted === null) {
    throw new CommandFailedError('Onboarding cancelled.');
  }
  if (!accepted) {
    return;
  }

  const integrateCtx = ctx.withAuth(auth);
  try {
    await runIntegrate(integrateCtx);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(
      `Could not set up your coding agents: ${reason}\nThe project setup is complete. Run 'sonar integrate' to try again.`,
    );
  } finally {
    integrateCtx.telemetryFacts().forEach((fact) => {
      ctx.recordTelemetry(fact);
    });
    integrateCtx.statsFacts().forEach((fact) => {
      ctx.recordStats(() => fact);
    });
  }
}
