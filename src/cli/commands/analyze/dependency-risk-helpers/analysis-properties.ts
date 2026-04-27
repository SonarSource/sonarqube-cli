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

// Routes the subset of `/api/settings/values` results consumed by SCA
// analysis. CLI-352 will forward these to sca-scanner as
// `--scanner-property`, `--excluded-path`, and `--include-git-ignored-paths`.

import { getValueAsList, type SettingsValue } from '../../../../sonarqube/settings-value.ts';

const SCA_KEY_PREFIX = 'sonar.sca.';
const EXCLUSION_KEYS = new Set([
  'sonar.exclusions',
  'sonar.global.exclusions',
  'sonar.test.exclusions',
]);
const SCM_EXCLUSIONS_DISABLED_KEY = 'sonar.scm.exclusions.disabled';

export interface ScaProjectAnalysisProperties {
  scaProperties: Record<string, string>;
  exclusions: string[];
  includeGitIgnoredPaths: boolean;
}

export function parseAnalysisProperties(settings: SettingsValue[]): ScaProjectAnalysisProperties {
  const scaProperties: Record<string, string> = {};
  const exclusions: string[] = [];
  let includeGitIgnoredPaths = false;

  for (const setting of settings) {
    if (EXCLUSION_KEYS.has(setting.key)) {
      exclusions.push(...getValueAsList(setting));
    } else if (setting.key === SCM_EXCLUSIONS_DISABLED_KEY) {
      includeGitIgnoredPaths = setting.value === 'true';
    } else if (setting.key.startsWith(SCA_KEY_PREFIX)) {
      const list = getValueAsList(setting);
      if (list.length > 0) {
        scaProperties[setting.key] = list.join(',');
      }
    }
  }

  return { scaProperties, exclusions, includeGitIgnoredPaths };
}
