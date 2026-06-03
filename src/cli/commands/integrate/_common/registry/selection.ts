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
 * Outcome of a feature's `shouldInstall` evaluation. Integrations declare the
 * intent; the installer resolves it (prompting / skip messaging) centrally.
 */
export type InstallDecision =
  | { action: 'install' }
  | { action: 'skip'; message?: string }
  | { action: 'ask'; question?: string };

/** Install the feature without asking. */
export function install(): InstallDecision {
  return { action: 'install' };
}

/** Skip the feature, optionally explaining why. */
export function skip(message?: string): InstallDecision {
  return { action: 'skip', message };
}

/** Ask the user whether to install the feature, with an optional custom prompt. */
export function askUser(question?: string): InstallDecision {
  return { action: 'ask', question };
}

/**
 * Coerce a `shouldInstall` result into an {@link InstallDecision}.
 *
 * A missing predicate defaults to asking the user (opt-in). An explicit `true`
 * installs without asking, `false` skips silently, and an explicit
 * {@link InstallDecision} passes through unchanged.
 */
export function normalizeDecision(result: boolean | InstallDecision | undefined): InstallDecision {
  if (result === undefined) {
    return askUser();
  }
  if (result === true) {
    return install();
  }
  if (result === false) {
    return skip();
  }
  return result;
}
