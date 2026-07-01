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

import type { ResolvedAuth } from '../../../lib/auth-resolver';
import { SonarQubeClient } from '../../../sonarqube/client';
import { info, intro, outro } from '../../../ui';
import { resolveOrg } from './_common/resolve-options';
import type { ImportOptions } from './_common/types';

export { type ImportOptions } from './_common/types';

export async function importHandler(options: ImportOptions, auth: ResolvedAuth): Promise<void> {
  const client = new SonarQubeClient(auth.serverUrl, auth.token);

  intro('Import repository', 'SonarQube');

  const orgKey = await resolveOrg(client, options);
  info(`Organization: ${orgKey}`);

  outro('Organization selected', 'success');
}
