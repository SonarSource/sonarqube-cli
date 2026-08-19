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

import type { CliAuthenticatedContext } from '@/commands/cli-context.ts';
import { CommandFailedError } from '@/core/command-error.ts';
import { selectPrompt } from '@/core/ui';

import { assertIntegrateScopeOptions } from './_common/agent-integrate-prelude.ts';
import { integrateAntigravity } from './antigravity';
import { antigravityIntegration } from './antigravity/declaration.ts';
import { integrateClaude } from './claude';
import { claudeIntegration } from './claude/declaration.ts';
import { integrateCodex } from './codex';
import { codexIntegration } from './codex/declaration.ts';
import { integrateCopilot } from './copilot';
import { copilotIntegration } from './copilot/declaration.ts';
import { integrateCursor } from './cursor';
import { cursorIntegration } from './cursor/declaration.ts';
import { integrateGit } from './git';

export interface IntegrateBareOptions {
  project?: string;
  global?: boolean;
  /** Marks handlers as invoked via the bare router; forwarded to telemetry only. */
  isFromRouter?: boolean;
}

type Handler = (options: IntegrateBareOptions, ctx: CliAuthenticatedContext) => Promise<void>;

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
  ctx: CliAuthenticatedContext,
  options: IntegrateBareOptions,
): Promise<void> {
  assertIntegrateScopeOptions(options);

  const selected = await selectPrompt(
    'Select the tool you want to integrate with',
    TOOLS.map((tool) => ({ value: tool, label: tool.label })),
  );

  if (!selected) throw new CommandFailedError('No integration selected');

  await selected.handler({ ...options, isFromRouter: true }, ctx);
}
