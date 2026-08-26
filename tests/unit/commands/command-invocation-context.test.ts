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

import { describe, expect, it } from 'bun:test';

import {
  CommandInvocationContext,
  createTelemetryFactBuffer,
  TelemetryFact,
} from '@/commands/command-invocation-context.ts';

describe('CommandInvocationContext stage accessors', () => {
  it('defaults to non-alpha / non-beta', () => {
    const ctx = new CommandInvocationContext();
    expect(ctx.isAlphaEligible()).toBe(false);
    expect(ctx.isBetaEligible()).toBe(false);
  });

  it('isAlphaEligible requires both Alpha stage and alpha enabled', () => {
    const stage = { isAlpha: true, isBeta: false, isPrivateBeta: false };
    expect(
      new CommandInvocationContext(stage, {
        isAlphaEnabled: false,
        isPrivateBetaEnabled: () => false,
      }).isAlphaEligible(),
    ).toBe(false);
    expect(
      new CommandInvocationContext(stage, {
        isAlphaEnabled: true,
        isPrivateBetaEnabled: () => false,
      }).isAlphaEligible(),
    ).toBe(true);
  });

  it('isBetaEligible is true for Open Beta without consulting entitlement', () => {
    const ctx = new CommandInvocationContext(
      { isAlpha: false, isBeta: true, isPrivateBeta: false },
      { isAlphaEnabled: false, isPrivateBetaEnabled: () => false },
    );
    expect(ctx.isBetaEligible()).toBe(true);
  });

  it('isBetaEligible for Private Beta requires entitlement', () => {
    const stage = {
      isAlpha: false,
      isBeta: true,
      isPrivateBeta: true,
      betaFlagKey: 'cli.beta.demo',
    };
    expect(
      new CommandInvocationContext(stage, {
        isAlphaEnabled: false,
        isPrivateBetaEnabled: () => false,
      }).isBetaEligible(),
    ).toBe(false);
    expect(
      new CommandInvocationContext(stage, {
        isAlphaEnabled: false,
        isPrivateBetaEnabled: (key) => key === 'cli.beta.demo',
      }).isBetaEligible(),
    ).toBe(true);
  });

  it('recordTelemetry no-ops without a buffer and appends when one is provided', () => {
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

    new CommandInvocationContext().recordTelemetry(fact);

    const buffer = createTelemetryFactBuffer();
    new CommandInvocationContext(
      { isAlpha: false, isBeta: false, isPrivateBeta: false },
      { isAlphaEnabled: false, isPrivateBetaEnabled: () => false },
      buffer,
    ).recordTelemetry(fact);
    expect(buffer.facts).toEqual([fact]);
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
    const auth = {
      connectionType: 'cloud' as const,
      serverUrl: 'https://sonarcloud.io',
      token: 't',
      orgKey: 'org',
    };
    const fact = new TelemetryFact('CliAnalysisCompleted', { ok: true }, { auth });
    expect(fact.auth).toBe(auth);
    expect(fact.timestamp).toBeGreaterThan(0);
  });
});
