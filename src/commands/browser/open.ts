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

import { isValidServerUrl } from '@/core/auth/auth-resolver.ts';
import { CommandFailedError, InvalidOptionError } from '@/core/commands/command-error.ts';
import type { CommandInvocationContext } from '@/core/commands/invocation-context.ts';
import { openBrowser } from '@/core/host/browser.ts';

export async function browserOpen(url: string, ctx: CommandInvocationContext): Promise<void> {
  if (!isValidServerUrl(url))
    throw new InvalidOptionError(
      'Browser URL must be an absolute HTTP(S) URL without control characters.',
    );
  const parsed = new URL(url);
  if (parsed.username || parsed.password)
    throw new InvalidOptionError('Browser URL must not contain credentials.');
  try {
    await openBrowser(parsed.href);
  } catch {
    throw new CommandFailedError('Could not open your browser.', {
      remediationHint: 'Open the browser-action URL manually, then return to your agent.',
    });
  }
  ctx.console.info(
    'Browser opened. Complete the displayed step, then return to your agent.',
    'stderr',
  );
}
