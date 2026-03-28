/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

import { isSonarQubeCloud } from '../../../../lib/auth-resolver';
import type { ResolvedAuth } from '../../../../lib/auth-resolver';
import { blank, text, warn } from '../../../../ui';
import type { DiscoveredProject } from '../../_common/discovery';
import { CommandFailedError } from '../../_common/error';

export interface IntegrateProjectOptions {
  project?: string;
}

export interface ConfigurationData {
  serverURL: string;
  projectKey: string | undefined;
  organization: string | undefined;
  token: string;
}

const DEFAULT_NO_PROJECT_KEY_MESSAGE =
  'No project key provided - project related actions will be skipped.';

/**
 * Load configuration from auth and discovered project (shared by Claude and Codex integrate).
 */
export function loadIntegrateConfiguration(
  project: DiscoveredProject,
  options: IntegrateProjectOptions,
  auth: ResolvedAuth,
): ConfigurationData {
  if (!!auth.serverUrl && !!project.serverUrl && auth.serverUrl != project.serverUrl) {
    warn(
      'Detected a Server URL mismatch between the current project configuration and the auth logged in configuration. If this is not intended please consider running "sonar auth logout" and re-run the integrate command',
    );
  }

  if (!!auth.orgKey && !!project.organization && auth.orgKey != project.organization) {
    warn(
      'Detected an organization mismatch between the current project configuration and the auth logged in configuration. If this is not intended please consider running "sonar auth logout" and re-run the integrate command',
    );
  }

  return {
    serverURL: auth.serverUrl,
    organization: auth.orgKey,
    projectKey: options.project || project.projectKey,
    token: auth.token,
  };
}

/**
 * Validate Cloud org and print summary lines. `noProjectKeyMessage` customizes the line when no key.
 */
export function validateIntegrateConfiguration(
  project: DiscoveredProject,
  config: ConfigurationData,
  noProjectKeyMessage: string = DEFAULT_NO_PROJECT_KEY_MESSAGE,
): void {
  if (isSonarQubeCloud(config.serverURL) && !config.organization) {
    throw new CommandFailedError(
      'SonarQube Cloud requires an organization. Please run "sonar auth logout" and re-authenticate with an organization.',
    );
  }

  blank();
  text(`Server: ${config.serverURL}`);

  if (config.organization) {
    text(`Organization: ${config.organization}`);
  }

  if (project.isGitRepo) {
    text('Git repository detected');
  }

  text(`Project root: ${project.rootDir}`);

  if (config.projectKey) {
    text(`Project: ${config.projectKey}`);
  } else {
    text(noProjectKeyMessage);
  }
}
