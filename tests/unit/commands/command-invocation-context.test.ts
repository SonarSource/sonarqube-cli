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

import { describe, expect, it, spyOn } from 'bun:test';

import { AuthResolver, ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { type CliRuntime, createCliRuntime } from '@/core/commands/cli-runtime.ts';
import {
  CommandAuthenticatedInvocationContext,
  CommandInvocationContext,
  TelemetryFact,
} from '@/core/commands/invocation-context.ts';
import type { LifecycleState } from '@/core/commands/sonar-command.ts';

import { FakeConsole } from '../../_common/fake-console.ts';

const FAKE_AUTH = new ResolvedAuth({
  token: 'fake-token',
  serverUrl: 'https://sonar.example.com',
  connectionType: 'on-premise',
  source: 'state' as const,
});

function runtime(overrides: Partial<CliRuntime> = {}): CliRuntime {
  return createCliRuntime(overrides);
}

function ctx(
  lifecycle?: LifecycleState,
  runtimeOverrides?: Partial<CliRuntime>,
  console: FakeConsole = new FakeConsole(),
): CommandInvocationContext {
  return new CommandInvocationContext(console, lifecycle, runtime(runtimeOverrides));
}

describe('CommandInvocationContext stage accessors', () => {
  it('defaults to non-alpha / non-beta', () => {
    expect(ctx().isAlphaEligible()).toBe(false);
    expect(ctx().isBetaEligible()).toBe(false);
  });

  it('isAlphaEligible requires both Alpha stage and alpha enabled', () => {
    const stage: LifecycleState = { stage: 'alpha' };
    expect(
      ctx(stage, {
        isAlphaEnabled: false,
      }).isAlphaEligible(),
    ).toBe(false);
    expect(
      ctx(stage, {
        isAlphaEnabled: true,
      }).isAlphaEligible(),
    ).toBe(true);
  });

  it('isBetaEligible is true for Open Beta without consulting entitlement', () => {
    const context = ctx({ stage: 'beta' });
    expect(context.isBetaEligible()).toBe(true);
  });

  it('isBetaEligible for Private Beta requires entitlement', () => {
    const stage: LifecycleState = { stage: 'beta', betaFlagKey: 'cli.beta.demo' };
    expect(
      ctx(stage, {
        isPrivateBetaEnabled: () => false,
      }).isBetaEligible(),
    ).toBe(false);
    expect(
      ctx(stage, {
        isPrivateBetaEnabled: (key) => key === 'cli.beta.demo',
      }).isBetaEligible(),
    ).toBe(true);
  });

  it('isBetaEligible for Private Beta is false when runtime is omitted', () => {
    expect(ctx({ stage: 'beta', betaFlagKey: 'cli.beta.demo' }).isBetaEligible()).toBe(false);
  });

  it('exposes the injected console', () => {
    const fake = new FakeConsole();
    expect(ctx(undefined, undefined, fake).console).toBe(fake);
  });

  it('recordTelemetry no-ops on empty input', () => {
    const context = ctx();
    context.recordTelemetry();
    expect(context.telemetryFacts()).toEqual([]);
  });

  it('recordTelemetry appends facts onto the context', () => {
    const fact = new TelemetryFact('CliAnalysisCompleted', {
      caller_command: 'analyze secrets',
      analyzer: 'sonar-secrets' as const,
      analysis_id: 'a',
      findings_count: 0,
      exit_code: 0,
      errors_count: 0,
      failures_count: 0,
      scan_duration_ms: 1,
      details: '',
    });

    const context = ctx();
    context.recordTelemetry(fact);
    expect(context.telemetryFacts()).toEqual([fact]);
    expect(context.telemetryFacts()).not.toBe(context.telemetryFacts());
  });
});

type AuthResolverInternals = AuthResolver & {
  resolveFromState: () => Promise<ResolvedAuth | null>;
};

function spyResolveFromState(): ReturnType<typeof spyOn> {
  return spyOn(AuthResolver.prototype as AuthResolverInternals, 'resolveFromState');
}

describe('CommandInvocationContext.resolveAuth', () => {
  it('reuses a warmed AuthResolver without calling the resolver again', async () => {
    const resolveFromStateSpy = spyResolveFromState().mockResolvedValue(FAKE_AUTH);
    const sharedRuntime = createCliRuntime({
      authResolver: new AuthResolver({ silent: true }),
    });
    await sharedRuntime.authResolver.resolveAuth();

    const context = new CommandInvocationContext(new FakeConsole(), undefined, sharedRuntime);
    const result = await context.resolveAuth();

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual(FAKE_AUTH);
    expect(resolveFromStateSpy).toHaveBeenCalledTimes(1);
    resolveFromStateSpy.mockRestore();
  });

  it('memoizes auth resolution on the shared runtime', async () => {
    const resolveFromStateSpy = spyResolveFromState().mockResolvedValue(null);
    const sharedRuntime = createCliRuntime({
      authResolver: new AuthResolver({ silent: true }),
    });
    const contextA = new CommandInvocationContext(new FakeConsole(), undefined, sharedRuntime);
    const contextB = new CommandInvocationContext(new FakeConsole(), undefined, sharedRuntime);

    await contextA.resolveAuth();
    await contextB.resolveAuth();

    expect(resolveFromStateSpy).toHaveBeenCalledTimes(1);
    resolveFromStateSpy.mockRestore();
  });

  it('returns authenticated auth from the constructor without re-resolving', async () => {
    const authResolver = new AuthResolver();
    const resolveAuthSpy = spyOn(authResolver, 'resolveAuth');
    const context = new CommandAuthenticatedInvocationContext(
      FAKE_AUTH,
      new FakeConsole(),
      undefined,
      createCliRuntime({ authResolver }),
    );

    const result = await context.resolveAuth();

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual(FAKE_AUTH);
    expect(resolveAuthSpy).not.toHaveBeenCalled();
  });
});

describe('TelemetryFact', () => {
  it('stamps timestamp on construction', () => {
    const before = Date.now();
    const fact = new TelemetryFact('CliAnalysisCompleted', { ok: true });
    const after = Date.now();
    expect(fact.timestamp).toBeGreaterThanOrEqual(before);
    expect(fact.timestamp).toBeLessThanOrEqual(after);
  });

  it('accepts an explicit timestamp override', () => {
    const fact = new TelemetryFact('CliAnalysisCompleted', { ok: true }, 1_700_000_000_000);
    expect(fact.timestamp).toBe(1_700_000_000_000);
  });

  it('accepts auth via options', () => {
    const auth = new ResolvedAuth({
      connectionType: 'cloud',
      source: 'state',
      serverUrl: 'https://sonarcloud.io',
      token: 't',
      orgKey: 'org',
    });
    const fact = new TelemetryFact('CliAnalysisCompleted', { ok: true }, { auth });
    expect(fact.auth).toBe(auth);
    expect(fact.timestamp).toBeGreaterThan(0);
  });
});
