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

import type { ResolvedAuth } from '@/core/auth/auth-resolver.ts';

/** Command stage snapshot used to resolve invocation-scoped alpha/beta flags. */
export type CliContextStage = {
  isAlpha: boolean;
  isBeta: boolean;
  isPrivateBeta: boolean;
  betaFlagKey?: string;
};

/**
 * Runtime gates consulted when answering whether this execution should be
 * treated as alpha / beta (mirrors {@link CliRuntime} fields used by stage
 * visibility, without importing `SonarCommand`).
 */
export type CliContextRuntime = {
  isAlphaEnabled: boolean;
  isPrivateBetaEnabled: (flagKey: string) => boolean;
};

const STABLE_STAGE: CliContextStage = {
  isAlpha: false,
  isBeta: false,
  isPrivateBeta: false,
};

const DISABLED_RUNTIME: CliContextRuntime = {
  isAlphaEnabled: false,
  isPrivateBetaEnabled: () => false,
};

/**
 * Per-command invocation context for handlers that do not require auth.
 *
 * Built by `SonarCommand.anonymousAction`. Stage accessors are methods so they
 * can combine the command's `.stage()` with runtime entitlement (alpha env /
 * Private Beta LaunchDarkly), not merely echo the stage name.
 */
export class CliContext {
  constructor(
    private readonly stage: CliContextStage = STABLE_STAGE,
    private readonly runtime: CliContextRuntime = DISABLED_RUNTIME,
  ) {}

  /** True when this command is Alpha and alpha is enabled for this run. */
  isAlpha(): boolean {
    return this.stage.isAlpha && this.runtime.isAlphaEnabled;
  }

  /**
   * True when this execution should be treated as beta: Open Beta, or Private
   * Beta with the user entitled for the command's LaunchDarkly flag.
   */
  isBeta(): boolean {
    if (!this.stage.isBeta) {
      return false;
    }
    if (!this.stage.isPrivateBeta) {
      return true;
    }
    const flagKey = this.stage.betaFlagKey;
    return flagKey !== undefined && this.runtime.isPrivateBetaEnabled(flagKey);
  }
}

/**
 * Per-command invocation context for authenticated handlers.
 *
 * Built by `SonarCommand.authenticatedAction`. Extends {@link CliContext} with
 * resolved auth for this invocation.
 */
export class CliAuthenticatedContext extends CliContext {
  constructor(
    readonly auth: ResolvedAuth,
    stage?: CliContextStage,
    runtime?: CliContextRuntime,
  ) {
    super(stage, runtime);
  }
}
