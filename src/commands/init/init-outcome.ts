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

/**
 * The onboarding path `sonar init` selected for the follow-up tickets to run.
 * `projectRoot` is always the directory `init` was pointed at (`--path`, default the current one).
 * `remote` is the git origin URL without embedded credentials.
 */
export type InitOutcome =
  /**
   * Nothing to do: `.sonar-config.json` already links this directory to the active connection.
   * `projectKeys` is a list because `.sonar-config.json` can map several projects, for a monorepo.
   */
  | { path: 'complete'; projectRoot: string; projectKeys: string[] }
  /** The server already binds the git remote to a project of the active organization. */
  | { path: 'link-existing'; projectRoot: string; projectKey: string }
  /** No project exists yet and the user agreed to bind the new one to the repository. */
  | { path: 'bound-new'; projectRoot: string; remote: string; projectKey?: string }
  /**
   * No project exists yet and it will not be bound to the repository: there is no git remote
   * (`remote` absent), the platform cannot be bound, or the user declined or could not be asked.
   */
  | { path: 'unbound-new'; projectRoot: string; remote?: string };
