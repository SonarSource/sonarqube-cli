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
import { PrivateBetaFlagRegistry } from '@/core/commands/private-beta-flag-registry.ts';
import { ALPHA_ENV_VAR } from '@/core/commands/stage.ts';
import { FlagsResolver } from '@/core/launch-darkly/flags-resolver.ts';
import type { Console } from '@/core/ui/console.ts';

/** Shared per-invocation context for command-tree construction and execution. */
export interface CliRuntime {
  /** Whether Alpha commands are visible for this invocation. */
  isAlphaEnabled: boolean;
  /** Resolves auth at most once for this CLI process invocation. */
  authResolver: AuthResolver;
  /** Resolves Private Beta flags at most once, via {@link authResolver}. */
  flagsResolver: FlagsResolver;
  /** Private Beta flag keys collected while registering staged commands/options. */
  privateBetaFlags: PrivateBetaFlagRegistry;
  /** Private Beta registration gate; Open Beta ignores this. */
  isPrivateBetaEnabled: (flagKey: string) => boolean;
}

/** Reads {@link ALPHA_ENV_VAR} (`true` / `1` enable Alpha commands). */
export function isAlphaEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[ALPHA_ENV_VAR];
  return value === 'true' || value === '1';
}

export function createCliRuntime(options?: {
  console?: Console;
  isAlphaEnabled?: boolean;
  authResolver?: AuthResolver;
  flagsResolver?: FlagsResolver;
  privateBetaFlags?: PrivateBetaFlagRegistry;
  /** Test override; production uses {@link FlagsResolver.isPrivateBetaEnabled}. */
  isPrivateBetaEnabled?: (flagKey: string) => boolean;
}): CliRuntime {
  const privateBetaFlags = options?.privateBetaFlags ?? new PrivateBetaFlagRegistry();
  const authResolver =
    options?.authResolver ?? new AuthResolver({ silent: true, console: options?.console });
  const flagsResolver = options?.flagsResolver ?? new FlagsResolver(authResolver, privateBetaFlags);

  return {
    isAlphaEnabled: options?.isAlphaEnabled ?? isAlphaEnabledFromEnv(),
    authResolver,
    flagsResolver,
    privateBetaFlags,
    isPrivateBetaEnabled:
      options?.isPrivateBetaEnabled ?? ((flagKey) => flagsResolver.isPrivateBetaEnabled(flagKey)),
  };
}
