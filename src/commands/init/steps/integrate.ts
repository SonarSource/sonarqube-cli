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
import { integrateBare } from '@/commands/integrate/integrate-bare.ts';
import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';

import { requireAnswer } from '../answer.ts';
import {
  alreadyDone,
  declined,
  failed,
  skipped,
  type StepResult,
  success,
} from '../flow/step-result.ts';
import type { InitStep } from '../flow/step-runner.ts';

/**
 * Asks whether to set up coding agents now and runs `sonar integrate` when accepted. Without a
 * session (the user declined to create an organization) or a terminal there is nothing to offer. Onboarding has already succeeded by then, so a failure or an abort
 * inside integrate is a warning and never changes the exit code.
 */
export class IntegrateStep implements InitStep<undefined> {
  readonly ref = { step: 'integrate' } as const;

  constructor(
    private readonly ctx: CommandInvocationContext,
    private readonly auth: ResolvedAuth | undefined,
    private readonly interactive: boolean,
  ) {}

  run(): Promise<StepResult<undefined>> {
    if (!this.interactive || !this.auth) {
      return Promise.resolve(skipped(undefined));
    }
    if (findInstalledIntegrationIds().length > 0) {
      return Promise.resolve(alreadyDone(undefined));
    }
    return this.offer(this.auth);
  }

  private async offer(auth: ResolvedAuth): Promise<StepResult<undefined>> {
    const { ctx } = this;

    const { console } = ctx;
    const accepted = requireAnswer(
      await console.confirmPrompt("Set up your coding agents with 'sonar integrate' now?", true),
    );
    if (!accepted) {
      return declined(undefined);
    }

    const integrateCtx = ctx.withAuth(auth);
    try {
      await integrateBare(integrateCtx, {});
      return success(undefined);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(
        `Could not set up your coding agents: ${reason}\nThe project setup is complete. Run 'sonar integrate' to try again.`,
      );
      return failed(undefined);
    } finally {
      integrateCtx.telemetryFacts().forEach((fact) => {
        ctx.recordTelemetry(fact);
      });
      integrateCtx.statsFacts().forEach((fact) => {
        ctx.recordStats(() => fact);
      });
    }
  }
}
