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
 * The onboarding path `sonar init` selected, before anything ran.
 * `projectRoot` is always the directory `init` was pointed at (`--path`, default the current one).
 * `remote` is the git origin URL without embedded credentials.
 */
export type InitPath =
  /**
   * Nothing to do: `.sonar-config.json` already links this directory to the active connection.
   * `projectKeys` is a list because `.sonar-config.json` can map several projects, for a monorepo.
   */
  | { path: 'complete'; projectRoot: string; projectKeys: readonly string[] }
  /**
   * A project of the active organization already exists for this repository: the server binds the
   * git remote to it, or it is the project an earlier run generated the key of (then `remote` may
   * be absent).
   */
  | {
      path: 'link-existing';
      projectRoot: string;
      remote?: string;
      projectKey: string;
    }
  /** No project exists yet and the user agreed to bind the new one to the repository. */
  | {
      path: 'bound-new';
      projectRoot: string;
      remote: string;
      /** What `sonar import --repo` expects for the remote: `owner/repo`, or `project/repo` on Azure DevOps. */
      repositorySlug: string;
    }
  /**
   * No project exists yet and it will not be bound to the repository: there is no git remote
   * (`remote` absent), the platform cannot be bound, or the user declined or could not be asked.
   */
  | { path: 'unbound-new'; projectRoot: string; remote?: string };

/** What `sonar init` ended with once the selected path ran. */
export type InitOutcome =
  /** `.sonar-config.json` already linked this directory to the active connection. */
  | { kind: 'complete'; projectKeys: readonly string[] }
  /** The directory was mapped to a project that already existed on the server. */
  | { kind: 'linked'; projectKey: string }
  /** A project bound to the repository was created and mapped. */
  | { kind: 'bound'; projectKey: string }
  /** A project without repository binding was created, or found under its generated key, and mapped. */
  | { kind: 'unbound'; projectKey: string }
  /** The user declined the creation: nothing was created. */
  | { kind: 'declined' };

export type LinkExistingPath = Extract<InitPath, { path: 'link-existing' }>;
export type BoundNewPath = Extract<InitPath, { path: 'bound-new' }>;
export type UnboundNewPath = Extract<InitPath, { path: 'unbound-new' }>;
