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
  readonly replacementCommand: string | null;
};

/** Descriptor passed to `SonarCommand.stage` / `SonarOption.stage`. */
export type StageDescriptor =
  | { readonly name: 'stable' }
  | { readonly name: 'alpha' }
  | { readonly name: 'beta'; readonly flagKey?: string }
  | {
      readonly name: 'deprecated';
      readonly sinceVersion: string;
      readonly replacementCommand: string | null;
    };

function betaStage(flagKey?: string): StageDescriptor {
  return flagKey === undefined ? { name: 'beta' } : { name: 'beta', flagKey };
}

function deprecatedStage(options: DeprecatedStageOptions): StageDescriptor {
  return {
    name: 'deprecated',
    sinceVersion: options.sinceVersion,
    replacementCommand: options.replacementCommand,
  };
}

/**
 * Command lifecycle stage.
 * Stable/Alpha are constants; Beta is a function so an optional LaunchDarkly
 * flag key can only be attached to Private Beta commands; Deprecated is a
 * function so `sinceVersion` and `replacementCommand` (`null` when there is
 * none) are required at the call site.
 */
export const Stage = {
  Stable: { name: 'stable' } as const satisfies StageDescriptor,
  Alpha: { name: 'alpha' } as const satisfies StageDescriptor,
  Beta: betaStage,
  Deprecated: deprecatedStage,
};

export type LifecycleState = {
  stage: StageName;
  betaFlagKey: string | undefined;
  deprecatedSinceVersion: string | undefined;
  deprecatedReplacementCommand: string | null | undefined;
};

export const STABLE_LIFECYCLE: LifecycleState = {
  stage: 'stable',
  betaFlagKey: undefined,
  deprecatedSinceVersion: undefined,
  deprecatedReplacementCommand: undefined,
};

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
  replacementCommand: string | null,
): string {
  const base = `'${subject}' is deprecated since ${sinceVersion}`;
  return replacementCommand === null
    ? `${base}. There is no replacement.`
    : `${base}. Use '${replacementCommand}' instead.`;
}

export function resolveLifecycle(stage: StageDescriptor): LifecycleState {
  return stage.name === 'deprecated'
    ? {
        stage: 'deprecated',
        betaFlagKey: undefined,
        deprecatedSinceVersion: stage.sinceVersion,
        deprecatedReplacementCommand: stage.replacementCommand,
      }
    : {
        stage: stage.name,
        betaFlagKey: stage.name === 'beta' ? stage.flagKey : undefined,
        deprecatedSinceVersion: undefined,
        deprecatedReplacementCommand: undefined,
      };
}

export function isSameLifecycle(left: LifecycleState, right: LifecycleState): boolean {
  return (
    left.stage === right.stage &&
    left.betaFlagKey === right.betaFlagKey &&
    left.deprecatedSinceVersion === right.deprecatedSinceVersion &&
    left.deprecatedReplacementCommand === right.deprecatedReplacementCommand
  );
}

/** Whether a command or option at this stage should be registered for this runtime. */
export function isStageVisible(
  stage: StageName,
  flagKey: string | undefined,
  runtime: {
    isAlphaEnabled: boolean;
    isPrivateBetaEnabled: (flagKey: string) => boolean;
  },
): boolean {
  if (stage === 'alpha') {
    return runtime.isAlphaEnabled;
  }
  if (stage === 'beta' && flagKey !== undefined) {
    return runtime.isPrivateBetaEnabled(flagKey);
  }
  return true;
}
