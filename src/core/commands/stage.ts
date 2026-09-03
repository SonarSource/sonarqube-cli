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

export const ALPHA_ENV_VAR = 'SONARQUBE_CLI_ALPHA';
export const ALPHA_HELP_TAG = '[ALPHA]';
export const BETA_HELP_TAG = '[BETA]';
export const DEPRECATED_HELP_TAG = '[DEPRECATED]';
export const ALPHA_HELP_GROUP = '__SONARQUBE_CLI_ALPHA_COMMANDS__';

export type StageName = 'stable' | 'alpha' | 'beta' | 'deprecated';

/** Arguments for {@link Stage.Deprecated}. */
export type DeprecatedStageOptions = {
  readonly sinceVersion: string;
  readonly replacement: string | null;
};

/** Descriptor passed to `SonarCommand.stage` / `SonarOption.stage`. */
export type StageDescriptor =
  | { readonly name: 'stable' }
  | { readonly name: 'alpha' }
  | { readonly name: 'beta'; readonly flagKey?: string }
  | {
      readonly name: 'deprecated';
      readonly sinceVersion: string;
      readonly replacement: string | null;
    };

function betaStage(flagKey?: string): StageDescriptor {
  return flagKey === undefined ? { name: 'beta' } : { name: 'beta', flagKey };
}

function deprecatedStage(options: DeprecatedStageOptions): StageDescriptor {
  return {
    name: 'deprecated',
    sinceVersion: options.sinceVersion,
    replacement: options.replacement,
  };
}

/**
 * Command lifecycle stage.
 * Stable/Alpha are constants; Beta is a function so an optional LaunchDarkly
 * flag key can only be attached to Private Beta commands; Deprecated is a
 * function so `sinceVersion` and `replacement` (`null` when there is
 * none) are required at the call site.
 */
export const Stage = {
  Stable: { name: 'stable' } as const satisfies StageDescriptor,
  Alpha: { name: 'alpha' } as const satisfies StageDescriptor,
  Beta: betaStage,
  Deprecated: deprecatedStage,
};

export type LifecycleState =
  | { readonly stage: 'stable' }
  | { readonly stage: 'alpha' }
  | { readonly stage: 'beta'; readonly betaFlagKey: string | undefined }
  | {
      readonly stage: 'deprecated';
      readonly sinceVersion: string;
      readonly replacement: string | null;
    };

export const STABLE_LIFECYCLE: LifecycleState = Object.freeze({ stage: 'stable' });

export function withLifecycleTag(description: string, stage: StageName): string {
  if (stage === 'alpha') {
    return `${description} ${ALPHA_HELP_TAG}`;
  }
  if (stage === 'beta') {
    return `${description} ${BETA_HELP_TAG}`;
  }
  if (stage === 'deprecated') {
    return `${description} ${DEPRECATED_HELP_TAG}`;
  }
  return description;
}

export function deprecationWarning(
  subject: string,
  sinceVersion: string,
  replacement: string | null,
): string {
  const base = `'${subject}' is deprecated since ${sinceVersion}`;
  return replacement === null
    ? `${base}. There is no replacement.`
    : `${base}. Use '${replacement}' instead.`;
}

export function resolveLifecycle(stage: StageDescriptor): LifecycleState {
  if (stage.name === 'deprecated') {
    return {
      stage: 'deprecated',
      sinceVersion: stage.sinceVersion,
      replacement: stage.replacement,
    };
  }
  if (stage.name === 'beta') {
    return { stage: 'beta', betaFlagKey: stage.flagKey };
  }
  return { stage: stage.name };
}

export function isSameLifecycle(left: LifecycleState, right: LifecycleState): boolean {
  if (left.stage !== right.stage) {
    return false;
  }
  if (left.stage === 'beta' && right.stage === 'beta') {
    return left.betaFlagKey === right.betaFlagKey;
  }
  if (left.stage === 'deprecated' && right.stage === 'deprecated') {
    return left.sinceVersion === right.sinceVersion && left.replacement === right.replacement;
  }
  return true;
}

/** Whether a command or option at this stage should be registered for this runtime. */
export function isStageVisible(
  lifecycle: LifecycleState,
  runtime: {
    isAlphaEnabled: boolean;
    isPrivateBetaEnabled: (flagKey: string) => boolean;
  },
): boolean {
  if (lifecycle.stage === 'alpha') {
    return runtime.isAlphaEnabled;
  }
  if (lifecycle.stage === 'beta' && lifecycle.betaFlagKey !== undefined) {
    return runtime.isPrivateBetaEnabled(lifecycle.betaFlagKey);
  }
  return true;
}
