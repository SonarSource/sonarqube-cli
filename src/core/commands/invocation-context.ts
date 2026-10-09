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

import { NullAuthResolver, type ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { type CliRuntime, createCliRuntime } from '@/core/commands/cli-runtime.ts';
import { type LifecycleState, STABLE_LIFECYCLE } from '@/core/commands/stage.ts';
import logger from '@/core/observability/logger.ts';
import { okAsync, type ResultAsync } from '@/core/result.ts';
import type { SonarConnection } from '@/core/server/connection.ts';
import { isStatsCollectionEnabled } from '@/core/stats/enabled.ts';
import type { Console } from '@/core/ui/console.ts';

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

/**
 * Buffered stats observation recorded by a command handler, mirroring {@link TelemetryFact}.
 *
 * @param payload Business data recorded into the local stats ledger at `postAction`; typed
 *   at the producer, opaque here.
 */
export class StatsFact<TPayload = unknown> {
  constructor(readonly payload: TPayload) {}
}

const DISABLED_RUNTIME: CliRuntime = createCliRuntime({ authResolver: new NullAuthResolver() });

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
 * Human-facing output goes through {@link console} (`Console`), which callers
 * must provide. Production passes the process console from `SonarCommand`.
 */
export class CommandInvocationContext {
  private readonly telemetryFactsBuffer: TelemetryFact[] = [];
  private readonly statsFactsBuffer: StatsFact[] = [];
  private agentSessionId: string | null = null;
  private commandResult: 'success' | 'failure' | undefined;
  private pendingConnection?: Promise<SonarConnection | null>;

  constructor(
    readonly console: Console,
    private readonly lifecycle: LifecycleState = STABLE_LIFECYCLE,
    protected readonly runtime: CliRuntime = DISABLED_RUNTIME,
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

  /**
   * Resolve auth for this invocation. `Ok(null)` means not authenticated;
   * `Err` means credentials could not be read (for example corrupt state).
   * Memoized for the lifetime of this context.
   */
  resolveAuth(options?: { silent?: boolean }): ResultAsync<ResolvedAuth | null, Error> {
    return this.runtime.authResolver.resolveAuth(options);
  }

  /**
   * Like {@link resolveAuth}, but treats resolution failures as unauthenticated instead of
   * propagating `Err` — matches the old `resolveAuth().catch(() => null)` hook/status paths.
   */
  async resolveAuthOrNull(options?: { silent?: boolean }): Promise<ResolvedAuth | null> {
    const authResult = await this.resolveAuth(options);
    if (authResult.isErr()) {
      logger.debug(`auth resolution failed: ${authResult.error.message}`);
      return null;
    }
    return authResult.value;
  }

  /**
   * Resolve the connection for this invocation — the auth plus the transport bound to its server.
   * `null` when the invocation has no usable credentials: an anonymous handler may well be
   * authenticated, and one that is not still has to run, so this is an outcome rather than a
   * failure. Resolution failures are treated the same way, and logged by {@link resolveAuthOrNull}.
   *
   * Memoized, so every domain client built during the invocation shares one transport.
   */
  resolveConnection(options?: { silent?: boolean }): Promise<SonarConnection | null> {
    this.pendingConnection ??= this.openConnection(options);
    return this.pendingConnection;
  }

  private async openConnection(options?: { silent?: boolean }): Promise<SonarConnection | null> {
    const auth = await this.resolveAuthOrNull(options);
    return auth === null ? null : { auth, httpClient: this.runtime.httpClientFactory(auth) };
  }

  /** Record telemetry facts for `postAction` drain. */
  recordTelemetry(...facts: TelemetryFact[]): void {
    this.telemetryFactsBuffer.push(...facts);
  }

  /** Snapshot of facts recorded during this invocation. */
  telemetryFacts(): readonly TelemetryFact[] {
    return this.telemetryFactsBuffer.slice();
  }

  /**
   * Buffer a stats fact for `postAction` drain. `factory` runs only when local stats
   * collection is enabled.
   */
  recordStats(factory: () => StatsFact): void {
    if (!isStatsCollectionEnabled()) {
      return;
    }
    this.statsFactsBuffer.push(factory());
  }

  /** Snapshot of stats facts recorded during this invocation. */
  statsFacts(): readonly StatsFact[] {
    return this.statsFactsBuffer.slice();
  }

  /** Store the agent session id for telemetry emitted after a hook completes. */
  setAgentSessionId(agentSessionId: string | null): void {
    this.agentSessionId = agentSessionId;
  }

  /** Return the session id supplied by the current agent hook. */
  currentAgentSessionId(): string | null {
    return this.agentSessionId;
  }

  /** Override the command result reported in the command-executed telemetry fact. */
  setCommandResult(commandResult: 'success' | 'failure'): void {
    this.commandResult = commandResult;
  }

  /** Return an explicit command result when a handler defines its own outcome. */
  currentCommandResult(): 'success' | 'failure' | undefined {
    return this.commandResult;
  }
}

/**
 * Per-command invocation context for authenticated handlers.
 *
 * Built by `SonarCommand.authenticatedAction`. Extends {@link CommandInvocationContext} with
 * resolved auth for this invocation.
 */
export class CommandAuthenticatedInvocationContext extends CommandInvocationContext {
  private memoizedConnection?: SonarConnection;

  constructor(
    readonly auth: ResolvedAuth,
    console: Console,
    lifecycle?: LifecycleState,
    runtime?: CliRuntime,
  ) {
    super(console, lifecycle, runtime);
  }

  override resolveAuth(): ResultAsync<ResolvedAuth, never> {
    return okAsync(this.auth);
  }

  override resolveAuthOrNull(): Promise<ResolvedAuth> {
    return Promise.resolve(this.auth);
  }

  /**
   * The connection for this invocation. Synchronous here because {@link auth} is already
   * resolved; memoised, so domain clients are built from this transport and never a fresh one.
   */
  get connection(): SonarConnection {
    this.memoizedConnection ??= {
      auth: this.auth,
      httpClient: this.runtime.httpClientFactory(this.auth),
    };
    return this.memoizedConnection;
  }

  override resolveConnection(): Promise<SonarConnection> {
    return Promise.resolve(this.connection);
  }
}
