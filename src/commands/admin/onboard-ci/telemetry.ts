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

import { TelemetryFact } from '@/core/commands/invocation-context.ts';
import type { DevOpsPlatform } from '@/core/devops/token.ts';

interface OnboardingTelemetryPayload {
  platform: DevOpsPlatform;
  // Count only successful creation responses; recovered requests have uncertain attribution.
  created_count: number;
  existing_count: number;
  // Repository failures; command-level failures remain in CliCommandExecuted.
  failed_count: number;
}

export class OnboardingTelemetry extends TelemetryFact<OnboardingTelemetryPayload> {
  constructor(platform: DevOpsPlatform) {
    super('CliCiOnboarding', {
      platform,
      created_count: 0,
      existing_count: 0,
      failed_count: 0,
    });
  }

  addCreated(): void {
    this.payload.created_count++;
  }

  addSkipped(reason: string): void {
    if (['PR_ALREADY_OPEN', 'MR_ALREADY_OPEN'].includes(reason)) {
      this.payload.existing_count++;
    }
  }

  addFailed(): void {
    this.payload.failed_count++;
  }
}
