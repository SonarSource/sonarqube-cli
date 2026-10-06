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

import type { Console } from '@/core/ui/console.ts';

export type OnboardingStep = 'connect_account' | 'github_access' | 'cloud_setup' | 'analysis';
export type OnboardingEvent = {
  event: 'step_started' | 'step_completed' | 'browser_required' | 'step_failed';
  step: OnboardingStep;
  actor: 'agent' | 'user';
  message: string;
  url?: string;
};

/** Progress uses stderr so final result JSON on stdout remains pipeable. */
export class OnboardingProgress {
  private currentStep?: OnboardingStep;
  private readonly completedSteps = new Set<OnboardingStep>();

  constructor(
    private readonly console: Console,
    private readonly events = false,
  ) {}

  start(step: OnboardingStep, message: string): void {
    if (this.currentStep === step) return;
    this.currentStep = step;
    this.emit({ event: 'step_started', step, actor: 'agent', message });
  }

  complete(step: OnboardingStep, message: string): void {
    if (this.completedSteps.has(step)) return;
    this.completedSteps.add(step);
    this.emit({ event: 'step_completed', step, actor: 'agent', message });
  }

  browser(step: OnboardingStep, url: string, message: string): void {
    this.currentStep = step;
    this.emit({ event: 'browser_required', step, actor: 'user', url, message });
  }

  fail(message: string): void {
    if (this.currentStep)
      this.emit({ event: 'step_failed', step: this.currentStep, actor: 'agent', message });
  }

  private emit(event: OnboardingEvent): void {
    if (this.events) this.console.print(JSON.stringify({ schemaVersion: 1, ...event }), 'stderr');
    else this.console.info(event.url ? `${event.message} ${event.url}` : event.message, 'stderr');
  }
}
