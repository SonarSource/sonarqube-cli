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

import { SUPPORT_URL } from '../../../../lib/config-constants';
import { CommandFailedError } from '../../_common/error';
import type { IntegrationContext } from './registry/types';

export function getOptionalStringAttr(
  context: IntegrationContext,
  key: string,
): string | undefined {
  const value = context.attrs?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function getRequiredStringAttr(
  context: IntegrationContext,
  key: string,
  integrationDisplayName: string,
): string {
  const value = getOptionalStringAttr(context, key);
  if (value === undefined) {
    throw new CommandFailedError(
      `Could not complete the ${integrationDisplayName} integration: missing required data '${key}'.`,
      {
        remediationHint: `Report this issue: ${SUPPORT_URL}`,
      },
    );
  }
  return value;
}
