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

import {
  SECRETS_ERROR_SCANNING_TEMPLATE,
  SECRETS_NOTICE_BLOCKED_TEMPLATE,
} from '@/core/config-constants.ts';

import { PI_EXTENSION_HELPERS } from './extension-helpers.ts';

export const PI_EXTENSION_MANAGED_MARKER = 'Managed by `sonar integrate pi`';

export const PI_SECRETS_EXTENSION_CONTENT = String.raw`// ${PI_EXTENSION_MANAGED_MARKER} — do not edit by hand.
import { existsSync } from 'node:fs';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
${PI_EXTENSION_HELPERS}
const SECRETS_NOTICE_BLOCKED_TEMPLATE = ${JSON.stringify(SECRETS_NOTICE_BLOCKED_TEMPLATE)};
const SECRETS_ERROR_SCANNING_TEMPLATE = ${JSON.stringify(SECRETS_ERROR_SCANNING_TEMPLATE)};

function blockedMessage(reason: string): string {
  return SECRETS_NOTICE_BLOCKED_TEMPLATE.replace('{reason}', () => reason);
}
const NARROW_NO_BREAK_SPACE = '\u202F';
const CURLY_APOSTROPHE = '\u2019';
const NO_BYPASS_SENTENCE =
  'Do not attempt to access this file another way (e.g. via bash) — inform the user of the block and ask before taking any other action.';

interface PreToolUseDecision {
  block: boolean;
  reason?: string;
}

interface ChatMessageDecision {
  block: boolean;
  reason?: string;
  redactedText?: string;
  secretsFound?: number;
}

function isValidDecision(value: { block?: unknown; redactedText?: unknown } | null): boolean {
  return (
    typeof value?.block === 'boolean' &&
    (value.redactedText === undefined || typeof value.redactedText === 'string')
  );
}

async function runDecisionHook<T>(subcommand: string, payload: unknown): Promise<T> {
  const answer = await runHook<{ block?: unknown; redactedText?: unknown } | null>(subcommand, payload);
  if (!isValidDecision(answer)) throw new Error('unexpected answer from sonar hook ' + subcommand);
  return answer as T;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveReadPath(path: string, cwd: string): string {
  const resolved = resolveToCwd(path, cwd);
  const nfd = resolved.normalize('NFD');
  const candidates = [
    resolved,
    resolved.replace(/ (AM|PM)\./gi, NARROW_NO_BREAK_SPACE + '$1.'),
    nfd,
    resolved.replace(/'/g, CURLY_APOSTROPHE),
    nfd.replace(/'/g, CURLY_APOSTROPHE),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? resolved;
}

async function protectText(text: string, sessionID: string): Promise<string> {
  if (!text) return text;
  try {
    const decision = await runDecisionHook<ChatMessageDecision>('pi-chat-message', { text, sessionID });
    if (decision.block) return blockedMessage(decision.reason!);
    return decision.redactedText ?? text;
  } catch (error) {
    return blockedMessage(SECRETS_ERROR_SCANNING_TEMPLATE.replace('{reason}', () => describeError(error)));
  }
}

export default function (pi: ExtensionAPI) {
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'read') return;
    const path = (event.input as { path?: string }).path;
    if (!path) return;
    try {
      const decision = await runDecisionHook<PreToolUseDecision>('pi-pre-tool-use', {
        tool: 'read',
        filePath: resolveReadPath(path, ctx.cwd),
        sessionID: ctx.sessionManager.getSessionId(),
      });
      if (decision.block) {
        return { block: true, reason: (decision.reason ?? 'Sonar blocked this file read.') + ' ' + NO_BYPASS_SENTENCE };
      }
    } catch (error) {
      return {
        block: true,
        reason:
          'Sonar could not verify ' + path + ' for secrets (' + describeError(error) + '). Blocking as a precaution. ' + NO_BYPASS_SENTENCE,
      };
    }
  });

  pi.on('message_end', async (event, ctx) => {
    const message = event.message;
    try {
      if (message?.role !== 'user') return;
      const sessionID = ctx.sessionManager.getSessionId();
      if (typeof message.content === 'string') {
        return { message: { ...message, content: await protectText(message.content, sessionID) } };
      }
      const content = await Promise.all(
        message.content.map(async (part) =>
          part.type === 'text' ? { ...part, text: await protectText(part.text, sessionID) } : part,
        ),
      );
      return { message: { ...message, content } };
    } catch (error) {
      return { message: { ...message, content: blockedMessage(SECRETS_ERROR_SCANNING_TEMPLATE.replace('{reason}', () => describeError(error))) } };
    }
  });
}
`;
