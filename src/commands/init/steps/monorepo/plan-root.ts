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

import type { DetectDeps } from '../detect.ts';
import { ConfiguredRoot } from './configured-root.ts';
import { ConflictRoot } from './conflict-root.ts';
import { CreateRoot } from './create-root.ts';
import { MapExistingRoot } from './map-existing-root.ts';
import { OfferExistingRoot } from './offer-existing-root.ts';
import { RefusedRoot } from './refused-root.ts';
import type { MonorepoRoot, RootOnboarding } from './root-onboarding.ts';
import { UnavailableRoot } from './unavailable-root.ts';
import { UncheckedRoot } from './unchecked-root.ts';

/** Decides how a root is onboarded, once its inspection and the options are known. */
export function planRoot(
  target: MonorepoRoot,
  deps: DetectDeps,
  linkOnly: boolean,
): RootOnboarding {
  const { path, mapping, status } = target;
  const { auth, interactive } = deps;
  const { projectKey } = mapping;
  switch (status.kind) {
    case 'configured':
      return new ConfiguredRoot(target);
    case 'unavailable':
      return new UnavailableRoot(target, status.problem);
    case 'conflict':
      return new ConflictRoot(target, status.recordedKey);
    case 'unchecked':
      return new UncheckedRoot(target, status.reason, status.cause);
    case 'other-org':
      return new RefusedRoot(
        target,
        'link',
        'link_existing',
        `Project '${projectKey}' belongs to another organization than ${auth.orgKey ?? 'the active one'}, or is not accessible with this token.`,
      );
    case 'existing':
      // A key the user named is consent to map it; one the CLI guessed is asked about, as for a single project.
      if (!target.generated || linkOnly) {
        return new MapExistingRoot(target, deps);
      }
      return interactive
        ? new OfferExistingRoot(target, deps)
        : new RefusedRoot(
            target,
            'link',
            'link_existing',
            `Project '${projectKey}' already exists, and nothing says whether ${path} belongs to it. Name it with --root ${path}=<project key> to map it.`,
          );
    case 'new':
      return linkOnly
        ? new RefusedRoot(
            target,
            'create_project',
            'unbound_new',
            `Project '${projectKey}' does not exist in ${auth.orgKey ?? 'the active organization'}, and --link never creates one.`,
          )
        : new CreateRoot(target, deps);
  }
}
