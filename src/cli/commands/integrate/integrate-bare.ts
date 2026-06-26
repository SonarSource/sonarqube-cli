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
import { selectPrompt } from '../../../ui';
import { CommandFailedError } from '../_common/error';
import { assertIntegrateScopeOptions } from './_common/agent-integrate-prelude';
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

export interface IntegrateBareOptions {
  project?: string;
  global?: boolean;
}

type Handler = (options: IntegrateBareOptions, auth: ResolvedAuth) => Promise<void>;

const TOOLS: { label: string; handler: Handler }[] = [
  { label: claudeIntegration.displayName, handler: integrateClaude },
  { label: copilotIntegration.displayName, handler: integrateCopilot },
  { label: codexIntegration.displayName, handler: integrateCodex },
  { label: cursorIntegration.displayName, handler: integrateCursor },
  { label: antigravityIntegration.displayName, handler: integrateAntigravity },
  // Git has 3 separate tool declarations (native, husky, pre-commit)
  // but a single handler that detects which framework is in use.
  { label: 'Git', handler: integrateGit },
];

export async function integrateBare(
  auth: ResolvedAuth,
  options: IntegrateBareOptions,
): Promise<void> {
  assertIntegrateScopeOptions(options);

  const selected = await selectPrompt(
    'Select the tool you want to integrate with',
    TOOLS.map((tool) => ({ value: tool, label: tool.label })),
  );

  if (!selected) throw new CommandFailedError('No integration selected');

  await selected.handler(options, auth);
}
