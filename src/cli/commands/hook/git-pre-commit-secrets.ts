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
import { print } from '../../../ui';
import { CommandFailedError } from '../_common/error';
import { resolveSecretsBinaryPath } from '../_common/install/secrets';
import {
  EXIT_CODE_SECRETS_FOUND,
  parseSecretsJson,
  runSecretsBinary,
  warnScanErrors,
} from '../analyze/secrets';
import { handleScanError } from './hook-dependencies';

export async function runCommitSecretsStage(files: string[], auth: ResolvedAuth): Promise<void> {
  const binaryPath = resolveSecretsBinaryPath();
  if (!binaryPath) return;

  let result;
  try {
    result = await runSecretsBinary(binaryPath, files, auth);
  } catch (err) {
    handleScanError('Commit', err as Error);
    return;
  }

  const { issues, errors } = parseSecretsJson(result.stdout);
  warnScanErrors(errors);

  if ((result.exitCode ?? 1) === EXIT_CODE_SECRETS_FOUND) {
    if (issues.length > 0) {
      const lines = issues.map((issue) => {
        const location = issue.location ? `:${String(issue.location.startLine)}` : '';
        const secret = issue.maskedSecret ? ` (secret: ${issue.maskedSecret})` : '';
        return `  • ${issue.file ?? '(unknown)'}${location} — ${issue.description}${secret}`;
      });
      print(lines.join('\n'));
    } else if (result.stderr) {
      print(result.stderr);
    }
    throw new CommandFailedError('Secrets detected in staged files.', {
      remediationHint: 'Remove the reported secret, then retry the commit.',
    });
  }
}
