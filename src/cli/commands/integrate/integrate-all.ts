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
import { multiSelectPrompt } from '../../../ui';
import { CommandFailedError } from '../_common/error';
import { integrateAntigravity } from './antigravity';
import { antigravityIntegration } from './antigravity/declaration';
import { integrateClaude } from './claude';
import { claudeIntegration } from './claude/declaration';
import { integrateCodex } from './codex';
import { codexIntegration } from './codex/declaration';
import { integrateCopilot } from './copilot';
import { copilotIntegration } from './copilot/declaration';
import { integrateCursor } from './cursor';
import { cursorIntegration } from './cursor/declaration';
import { integrateGit } from './git';

export interface IntegrateAllOptions {
  project?: string;
  global?: boolean;
}

type Handler = (auth: ResolvedAuth, options: IntegrateAllOptions) => Promise<void>;

const TOOLS: { id: string; label: string; handler: Handler }[] = [
  {
    id: claudeIntegration.id,
    label: claudeIntegration.displayName,
    handler: (auth, opts) => integrateClaude(opts, auth),
  },
  {
    id: copilotIntegration.id,
    label: copilotIntegration.displayName,
    handler: (auth, opts) => integrateCopilot(auth, opts),
  },
  {
    id: codexIntegration.id,
    label: codexIntegration.displayName,
    handler: (auth, opts) => integrateCodex(opts, auth),
  },
  {
    id: cursorIntegration.id,
    label: cursorIntegration.displayName,
    handler: (auth, opts) => integrateCursor(opts, auth),
  },
  {
    id: antigravityIntegration.id,
    label: antigravityIntegration.displayName,
    handler: (auth, opts) => integrateAntigravity(opts, auth),
  },
  // Git has 3 separate tool declarations (native, husky, pre-commit)
  // but a single handler that detects which framework is in use.
  { id: 'git', label: 'Git', handler: (auth, opts) => integrateGit(opts, auth) },
];

export async function integrateAll(
  auth: ResolvedAuth,
  options: IntegrateAllOptions,
): Promise<void> {
  const selected = await multiSelectPrompt(
    'Select the tools you want to integrate with',
    TOOLS.map(({ id, label }) => ({ value: id, label })),
  );

  if (!selected || selected.length === 0) throw new CommandFailedError('No integration selected');

  for (const tool of TOOLS) {
    if (selected.includes(tool.id)) {
      await tool.handler(auth, options);
    }
  }
}
