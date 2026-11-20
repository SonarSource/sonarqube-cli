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

import {
  type CommandAuthenticatedInvocationContext,
  TelemetryFact,
} from '@/core/commands/invocation-context.ts';

export const USER_ONBOARDING_STARTED = 'UserOnboardingStarted';
export const USER_ONBOARDING_APP_IMPORTED = 'UserOnboardingAppImported';
export const USER_ONBOARDING_EXITED = 'UserOnboardingExited';
export const USER_ONBOARDING_COMPLETED = 'UserOnboardingCompleted';

/** `source` value the Tracking Plan reserves for events fired by the CLI. */
const ONBOARDING_SOURCE = 'cli';
const ONBOARDING_FLOW_VERSION = '1';

type OnboardingPayload = {
  source: typeof ONBOARDING_SOURCE;
  version: string;
  devops_platform?: string;
};

/**
 * Records the Tracking Plan's `UserOnboarding*` funnel for `sonar import`. `user_uuid` and
 * `organization_uuid_v4` are filled at drain time, so only the event-specific properties live here.
 *
 * Only the steps the CLI actually has are emitted: the plan, billing and organization-details
 * steps belong to the web flow, and the CLI never picks a DevOps platform (the organization must
 * already be bound to one), so `UserOnboardingDopSelected` never fires.
 */
export class ImportOnboardingTelemetry {
  private devopsPlatform: string | undefined;

  constructor(private readonly ctx: CommandAuthenticatedInvocationContext) {}

  /** The command was invoked. */
  started(): void {
    this.record(USER_ONBOARDING_STARTED, { plan_preselected: false });
  }

  /** The organization's already-installed DevOps platform app was resolved and supported. */
  appImported(almKey: string | undefined): void {
    this.devopsPlatform = almKey;
    this.record(USER_ONBOARDING_APP_IMPORTED, {});
  }

  /** The user backed out of repository selection. */
  exited(): void {
    this.record(USER_ONBOARDING_EXITED, {});
  }

  /** Every selected repository was imported. */
  completed(): void {
    this.record(USER_ONBOARDING_COMPLETED, {});
  }

  private record(name: string, extra: Record<string, unknown>): void {
    const payload: OnboardingPayload & Record<string, unknown> = {
      source: ONBOARDING_SOURCE,
      version: ONBOARDING_FLOW_VERSION,
      ...(this.devopsPlatform ? { devops_platform: this.devopsPlatform } : {}),
      ...extra,
    };
    this.ctx.recordTelemetry(new TelemetryFact(name, payload, { auth: this.ctx.auth }));
  }
}
