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

import { authLogin } from '@/commands/auth/login.ts';
import { AuthResolver, type ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError } from '@/core/commands/command-error.ts';
import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';

import { alreadyDone, type StepResult, success } from '../flow/step-result.ts';
import type { InitStep, StepRunner } from '../flow/step-runner.ts';
import { createOrganizationHook, OrganizationCreationDeclined } from './organization.ts';

/**
 * Reuses the current login, or signs the user in through the browser. On SonarQube Cloud the
 * login also settles the organization. An account with none is offered the creation of one; when
 * the user says no, the sign-in still succeeded, but there is no session to go on with.
 */
export class LoginStep implements InitStep<ResolvedAuth | undefined> {
  readonly ref = { step: 'login' } as const;

  constructor(
    private readonly ctx: CommandInvocationContext,
    private readonly interactive: boolean,
    private readonly dryRun: boolean,
    private readonly steps: StepRunner,
  ) {}

  async run(): Promise<StepResult<ResolvedAuth | undefined>> {
    const { ctx, interactive, dryRun } = this;

    const current = await ctx.resolveAuth({ silent: true });
    if (current.isErr()) {
      throw current.error;
    }
    if (current.value) {
      return alreadyDone(current.value);
    }

    // Signing in saves credentials, and the preview needs the server to check keys and projects.
    if (dryRun) {
      throw new CommandFailedError(
        'Not signed in: a dry run cannot sign in, since that saves credentials.',
        {
          remediationHint:
            "Run 'sonar auth login', or set SONARQUBE_CLI_TOKEN together with SONARQUBE_CLI_SERVER or SONARQUBE_CLI_ORG.",
        },
      );
    }

    if (!interactive) {
      throw new CommandFailedError('Not signed in.', {
        remediationHint:
          "Run 'sonar auth login', or set SONARQUBE_CLI_TOKEN together with SONARQUBE_CLI_SERVER or SONARQUBE_CLI_ORG.",
      });
    }
    return this.signIn();
  }

  private async signIn(): Promise<StepResult<ResolvedAuth | undefined>> {
    const { ctx, steps } = this;
    // todo check if this is necessary
    try {
      await authLogin({}, ctx, { onNoMemberships: createOrganizationHook(ctx.console, steps) });
    } catch (error) {
      if (error instanceof OrganizationCreationDeclined) {
        return success(undefined);
      }
      throw error;
    }
    return success(await this.resolveFreshAuth());
  }

  /** The invocation's resolver memoized the pre-login answer, so read the new login with a new one. */
  private async resolveFreshAuth(): Promise<ResolvedAuth> {
    const fresh = await new AuthResolver().resolveAuth({ silent: true });
    if (fresh.isErr()) {
      throw fresh.error;
    }
    if (!fresh.value) {
      throw new CommandFailedError('Sign-in finished, but no active connection was found.', {
        remediationHint: "Run 'sonar auth status' to inspect the saved connection.",
      });
    }
    return fresh.value;
  }
}
