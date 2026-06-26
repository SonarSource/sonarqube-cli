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

import type { IntegrationScope } from '../../../../lib/state';
import type { AppliedResource, IntegrationContext, ResourceDeclaration } from '../_common/registry';

/** Apply/remove a resource only when the install scope matches (project vs global). */
export function scopedResource(
  scope: IntegrationScope,
  resource: ResourceDeclaration,
): ResourceDeclaration {
  return {
    id: resource.id,
    displayName: resource.displayName,
    resourceType: resource.resourceType,
    version: resource.version,
    apply: async (context: IntegrationContext): Promise<AppliedResource> => {
      if (context.scope !== scope) {
        return {
          id: resource.id,
          resourceType: resource.resourceType,
          version: resource.version,
          path: '',
        };
      }
      return resource.apply(context);
    },
    isApplied: async (context: IntegrationContext): Promise<boolean> => {
      if (context.scope !== scope) {
        return true;
      }
      return resource.isApplied(context);
    },
    remove: async (context: IntegrationContext): Promise<void> => {
      if (context.scope !== scope) {
        return;
      }
      await resource.remove(context);
    },
  };
}
