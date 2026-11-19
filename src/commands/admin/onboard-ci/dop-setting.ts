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

import { CommandFailedError } from '@/core/commands/command-error.ts';
import type { DopSetting, ProjectBindingsClient } from '@/core/server/project-bindings.ts';

export async function resolveGitlabDopSetting(
  bindings: ProjectBindingsClient,
  bindingName?: string,
): Promise<DopSetting & { url: string }> {
  const settings = await bindings.listDopSettings('gitlab').orThrow();
  if (settings.length === 0) {
    throw new CommandFailedError(
      'No GitLab configuration found in SonarQube.\n' +
        '  → Configure one at Administration > DevOps Platform Integrations > GitLab.',
    );
  }
  return selectDopSetting(settings, 'GitLab', bindingName);
}

export async function resolveGithubDopSetting(
  bindings: ProjectBindingsClient,
  bindingName?: string,
): Promise<DopSetting & { url: string }> {
  const configured = await bindings.listDopSettings('github').orThrow();
  const settings = configured.filter(
    (setting) => setting.url?.replace(/\/$/, '').toLowerCase() === 'https://api.github.com',
  );
  if (settings.length === 0) {
    throw new CommandFailedError(
      'No GitHub.com configuration found in SonarQube.\n' +
        '  → Configure one at Administration > DevOps Platform Integrations > GitHub.\n' +
        'Only GitHub.com configurations (https://api.github.com) are supported.',
    );
  }
  return selectDopSetting(settings, 'GitHub', bindingName);
}

function selectDopSetting(
  settings: DopSetting[],
  label: string,
  bindingName?: string,
): DopSetting & { url: string } {
  const available = settings.map((setting) => `  ${setting.key}  (${setting.url})`).join('\n');
  const setting = bindingName
    ? settings.find((setting) => setting.key === bindingName)
    : settings[0];
  if (!setting) {
    throw new CommandFailedError(
      `${label} configuration '${bindingName}' not found. Available configurations:\n${available}`,
      { exitCode: 2 },
    );
  }
  if (!bindingName && settings.length > 1) {
    throw new CommandFailedError(
      `Multiple ${label} configurations found. Specify one with --binding-name:\n${available}`,
      { exitCode: 2 },
    );
  }
  if (!setting.url) {
    throw new CommandFailedError(`${label} configuration '${setting.key}' has no API URL.`);
  }
  return { ...setting, url: setting.url };
}
