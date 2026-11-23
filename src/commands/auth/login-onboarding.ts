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

import { AuthResolver } from '@/core/auth/auth-resolver.ts';
import { authMatchesRecordedConnection } from '@/core/auth/recorded-connection.ts';
import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { detectCallerAgent } from '@/core/host/environment/agent-detector.ts';
import { loadState } from '@/core/state/state-repository.ts';

import { resumePendingAgentSetups } from '../integrate/_common/bulk-agent-setup.ts';
import { pendingAgentSetups } from '../integrate/_common/pending-agent-setup.ts';
import { authLogin, type AuthLoginOptions } from './login.ts';

export async function loginAndResumeOnboarding(
  opts: AuthLoginOptions,
  ctx: CommandInvocationContext,
): Promise<void> {
  const target = await authLogin(opts, ctx);
  try {
    if (!pendingAgentSetups(loadState()).length) return;
    if (opts.withToken || !ctx.console.canPrompt() || detectCallerAgent()) {
      ctx.console.warn("Finish pending setup with 'sonar integrate --all --non-interactive'.");
      return;
    }
    const fresh = await new AuthResolver().resolveAuth({ silent: true });
    if (
      fresh.isOk() &&
      fresh.value &&
      authMatchesRecordedConnection(fresh.value, {
        serverUrl: target.server,
        organization: target.org,
      })
    ) {
      await resumePendingAgentSetups(ctx, fresh.value);
    }
  } catch {
    ctx.console.warn(
      "Sign-in succeeded. Retry pending setup with 'sonar integrate --all --non-interactive'.",
    );
  }
}
