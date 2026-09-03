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
import { type LifecycleState, STABLE_LIFECYCLE } from '@/core/commands/stage.ts';

/**
 * Runtime gates consulted when answering whether this execution should be
 * treated as alpha / beta (mirrors {@link CliRuntime} fields used by stage
 * visibility, without importing `SonarCommand`).
 */
export type CommandInvocationContextRuntime = {
  isAlphaEnabled: boolean;
  isPrivateBetaEnabled: (flagKey: string) => boolean;
};

/**
 * Named domain observation recorded by a command handler.
 *
 * Not the wire event: only the business-specific bits. Enrichment (identity,
 * `invocation_id`, etc.) happens when the tree drains the buffer into a
 * telemetry event.
 *
 * - `name` — short event name (no shared domain prefix)
 * - `payload` — business data; typed at the producer, opaque here
 * - `timestamp` — ms since epoch, defaulted at construction, overridable
 * - `auth` — command auth to resolve identity at drain; omit for store-event identity
 */
export type TelemetryFactOptions = {
  timestamp?: number;
  auth?: ResolvedAuth;
};

export class TelemetryFact<TPayload = unknown> {
  readonly timestamp: number;
  readonly auth?: ResolvedAuth;

  constructor(
    readonly name: string,
    readonly payload: TPayload,
    timestampOrOptions: number | TelemetryFactOptions = Date.now(),
  ) {
    if (typeof timestampOrOptions === 'number') {
      this.timestamp = timestampOrOptions;
    } else {
      this.timestamp = timestampOrOptions.timestamp ?? Date.now();
      this.auth = timestampOrOptions.auth;
    }
  }
}

const DISABLED_RUNTIME: CommandInvocationContextRuntime = {
  isAlphaEnabled: false,
  isPrivateBetaEnabled: () => false,
};

/**
 * Per-command invocation context for handlers that do not require auth.
 *
 * Built by `SonarCommand.anonymousAction`. Stage accessors are methods so they
 * can combine the command's `.stage()` with runtime entitlement (alpha env /
 * Private Beta LaunchDarkly), not merely echo the stage name.
 *
 * Facts are recorded with {@link recordTelemetry} and read via
 * {@link telemetryFacts} from `postAction` on the action command's context.
 * Payload shapes inside {@link TelemetryFact.payload} are owned by producers.
 */
export class CommandInvocationContext {
  private readonly facts: TelemetryFact[] = [];

  constructor(
    private readonly lifecycle: LifecycleState = STABLE_LIFECYCLE,
    private readonly runtime: CommandInvocationContextRuntime = DISABLED_RUNTIME,
  ) {}

  /** True when this command is Alpha and alpha is enabled for this run. */
  isAlphaEligible(): boolean {
    return this.lifecycle.stage === 'alpha' && this.runtime.isAlphaEnabled;
  }

  /**
   * True when this execution should be treated as beta: Open Beta, or Private
   * Beta with the user entitled for the command's LaunchDarkly flag.
   */
  isBetaEligible(): boolean {
    if (this.lifecycle.stage !== 'beta') {
      return false;
    }
    if (this.lifecycle.betaFlagKey === undefined) {
      return true;
    }
    return this.runtime.isPrivateBetaEnabled(this.lifecycle.betaFlagKey);
  }

  /** Record telemetry facts for `postAction` drain. */
  recordTelemetry(...facts: TelemetryFact[]): void {
    if (facts.length === 0) {
      return;
    }
    this.facts.push(...facts);
  }

  /** Snapshot of facts recorded during this invocation. */
  telemetryFacts(): readonly TelemetryFact[] {
    return this.facts.slice();
  }
}

/**
 * Per-command invocation context for authenticated handlers.
 *
 * Built by `SonarCommand.authenticatedAction`. Extends {@link CommandInvocationContext} with
 * resolved auth for this invocation.
 */
export class CommandAuthenticatedInvocationContext extends CommandInvocationContext {
  constructor(
    readonly auth: ResolvedAuth,
    lifecycle?: LifecycleState,
    runtime?: CommandInvocationContextRuntime,
  ) {
    super(lifecycle, runtime);
  }
}
