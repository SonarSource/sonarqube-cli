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

import type { AuthResolver } from '@/core/auth/auth-resolver.ts';
import type { PrivateBetaFlagRegistry } from '@/core/commands/private-beta-flag-registry.ts';

import { resolvePrivateBetaFlags } from './index.ts';

/** Memoizing Private Beta flag resolver; loads auth on first {@link resolveFlags}. */
export class FlagsResolver {
  private memo?: Promise<Record<string, boolean>>;
  private decisions: Record<string, boolean> = {};

  constructor(
    private readonly authResolver: AuthResolver,
    private readonly registry: PrivateBetaFlagRegistry,
    private readonly loadFlags: typeof resolvePrivateBetaFlags = resolvePrivateBetaFlags,
  ) {}

  isPrivateBetaEnabled(flagKey: string): boolean {
    return this.decisions[flagKey] ?? false;
  }

  /** Resolve LaunchDarkly flags at most once; no-op when the tree declares no keys. */
  async resolveFlags(): Promise<void> {
    const flagKeys = this.registry.flagKeys();
    if (flagKeys.length === 0) {
      return;
    }

    this.memo ??= this.load(flagKeys);
    this.decisions = await this.memo;
  }

  private async load(flagKeys: readonly string[]): Promise<Record<string, boolean>> {
    const authResult = await this.authResolver.resolveAuth();
    const auth = authResult.isOk() ? authResult.value : null;
    return this.loadFlags(auth, { flagKeys });
  }
}
