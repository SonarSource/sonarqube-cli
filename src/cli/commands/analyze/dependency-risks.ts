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
import { print } from '../../../ui';
import { CommandFailedError, InvalidOptionError } from '../_common/error.js';

export const VALID_FORMATS = ['json', 'table'];

export interface AnalyzeDependencyRisksOptions {
  project?: string;
  format?: string;
}

export async function analyzeDependencyRisks(
  options: AnalyzeDependencyRisksOptions,
  auth: ResolvedAuth,
): Promise<void> {
  if (!options.project) {
    throw new InvalidOptionError('--project is required');
  }

  const format = (options.format ?? 'table').toLowerCase();
  if (!VALID_FORMATS.includes(format)) {
    throw new InvalidOptionError(
      `Invalid format: '${options.format}'. Must be one of: ${VALID_FORMATS.join(', ')}`,
    );
  }

  const client = new SonarQubeClient(auth.serverUrl, auth.token);
  const enabled = await client.checkScaEnabled(auth.connectionType, auth.orgKey);
  if (!enabled) {
    throw new CommandFailedError('Advanced Security not available');
  }

  const stub = { project: options.project, risks: [] as unknown[] };
  print(
    format === 'json' ? JSON.stringify(stub, null, 2) : `Project: ${options.project}\n(no risks)`,
  );
}
