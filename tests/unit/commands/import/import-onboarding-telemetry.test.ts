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

import { ImportOnboardingTelemetry } from '@/commands/import/import-onboarding-telemetry.ts';
import { ResolvedAuth } from '@/core/auth/auth-resolver.ts';
import { CommandAuthenticatedInvocationContext } from '@/core/commands/invocation-context.ts';

import { FakeConsole } from '../../../_common/fake-console.ts';

const AUTH = new ResolvedAuth({
  connectionType: 'cloud',
  source: 'state' as const,
  serverUrl: 'https://sonarcloud.io',
  token: 'test-token',
  orgKey: 'my-org',
});

function setup() {
  const ctx = new CommandAuthenticatedInvocationContext(AUTH, new FakeConsole());
  return { ctx, onboarding: new ImportOnboardingTelemetry(ctx) };
}

describe('ImportOnboardingTelemetry', () => {
  it('records UserOnboardingStarted with no DevOps platform yet', () => {
    const { ctx, onboarding } = setup();

    onboarding.started();

    const [fact] = ctx.telemetryFacts();
    expect(fact.name).toBe('UserOnboardingStarted');
    expect(fact.payload).toEqual({ source: 'cli', version: '1', plan_preselected: false });
    expect(fact.auth).toBe(AUTH);
  });

  it('carries the DevOps platform on every event after AppImported', () => {
    const { ctx, onboarding } = setup();

    onboarding.started();
    onboarding.appImported('github');
    onboarding.completed();

    const facts = ctx.telemetryFacts();
    expect(facts.map((f) => f.name)).toEqual([
      'UserOnboardingStarted',
      'UserOnboardingAppImported',
      'UserOnboardingCompleted',
    ]);
    expect(facts[0].payload).not.toHaveProperty('devops_platform');
    expect(facts[1].payload).toEqual({ source: 'cli', version: '1', devops_platform: 'github' });
    expect(facts[2].payload).toEqual({ source: 'cli', version: '1', devops_platform: 'github' });
  });

  it('records UserOnboardingExited', () => {
    const { ctx, onboarding } = setup();

    onboarding.started();
    onboarding.appImported('microsoft');
    onboarding.exited();

    const facts = ctx.telemetryFacts();
    expect(facts[facts.length - 1].name).toBe('UserOnboardingExited');
    expect(facts[facts.length - 1].payload).toEqual({
      source: 'cli',
      version: '1',
      devops_platform: 'microsoft',
    });
  });
});
