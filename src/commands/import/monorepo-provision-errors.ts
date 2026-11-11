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

// `POST /api/alm_integration/provision_monorepo_projects` (internal, undocumented) reports a
// partly or wholly refused batch as HTTP 400 with `errors[].msg`: first
// `Could not provision some of the projects (<created>/<requested>)`, then one
// `<projectKey>: <message>` per refused project. Projects that were created stay committed and
// are not listed. Source: ProvisionMonorepoProjectsAction and its test in SonarSource/sonarcloud-core
// (SC-51950).

const SUMMARY = /^Could not provision some of the projects \((\d+)\/(\d+)\)$/;

export interface MonorepoProvisionErrors {
  /** Projects created, from the summary line. */
  created: number;
  /** Projects the server was asked to provision, from the summary line. */
  requested: number;
  /** Refusal message per project key, without the `<projectKey>: ` prefix. */
  refusals: Map<string, string>;
  /** Lines that name none of the requested projects. */
  untagged: string[];
}

/**
 * Reads a 400 body from `provision_monorepo_projects`. Returns `null` when it lacks the summary
 * line, which means the request itself was rejected and nothing was provisioned.
 *
 * A line is attributed by matching `<projectKey>: ` against the requested keys, longest key
 * first, because a project key may itself contain a colon.
 */
export function parseMonorepoProvisionErrors(
  projectKeys: readonly string[],
  errors: readonly string[],
): MonorepoProvisionErrors | null {
  const details = errors.slice(1);
  const counts = SUMMARY.exec(errors.at(0) ?? '');
  if (!counts) {
    return null;
  }
  const [, created, requested] = counts;

  const prefixes = projectKeys
    .map((key) => ({ key, prefix: `${key}: ` }))
    .sort((a, b) => b.prefix.length - a.prefix.length);
  const refusals = new Map<string, string>();
  const untagged: string[] = [];
  for (const line of details) {
    const match = prefixes.find(({ prefix }) => line.startsWith(prefix));
    if (match === undefined || refusals.has(match.key)) {
      untagged.push(line);
    } else {
      refusals.set(match.key, line.slice(match.prefix.length));
    }
  }
  return { created: Number(created), requested: Number(requested), refusals, untagged };
}

/**
 * Whether the refusals account for every project that was not created, so the others are known to
 * exist without asking the server. Anything else (an untagged line, a count that does not add up)
 * leaves them unverified.
 */
export function accountsForEveryProject(
  parsed: MonorepoProvisionErrors,
  requestedKeys: readonly string[],
): boolean {
  return (
    parsed.untagged.length === 0 &&
    parsed.requested === requestedKeys.length &&
    parsed.refusals.size === parsed.requested - parsed.created
  );
}
