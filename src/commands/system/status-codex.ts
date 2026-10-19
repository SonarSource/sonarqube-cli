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

import { readFileSync } from 'node:fs';

import { parse as parseToml } from 'smol-toml';

import type { Console } from '@/core/ui/console.ts';

interface ManagedHooks {
  path: string;
  events: string[];
}

export function readCodexManagedHooks(
  path = '/etc/codex/requirements.toml',
): ManagedHooks | undefined {
  try {
    const config = parseToml(readFileSync(path, 'utf8'));
    const hooks = config.hooks;
    if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return undefined;
    const events = Object.entries(hooks)
      .filter(([, entries]) => Array.isArray(entries) && entries.some(hasSonarHook))
      .map(([event]) => event);
    return events.length > 0 ? { path, events } : undefined;
  } catch {
    return undefined;
  }
}

export function renderCodexInstallation(
  recordedPath: string | undefined,
  console: Console,
  managedPath = process.env.__SQCLI_DEV_CODEX_REQUIREMENTS_PATH ?? '/etc/codex/requirements.toml',
): void {
  const managedHooks = readCodexManagedHooks(managedPath);
  const suffix = recordedPath ? ` (${recordedPath})` : '';
  console.text(`  • Codex: RECORDED AS INSTALLED${suffix}`);
  console.text('    Status does not verify hook delivery to the current session.');
  if (managedHooks) {
    console.text(
      `    Managed Sonar hooks (${managedHooks.path}): ${managedHooks.events.join(', ')}`,
    );
  }
}

function hasSonarHook(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object' || !('hooks' in entry)) return false;
  return Array.isArray(entry.hooks) && entry.hooks.some(isSonarCommand);
}

function isSonarCommand(hook: unknown): boolean {
  if (!hook || typeof hook !== 'object' || !('command' in hook)) return false;
  if (!('type' in hook) || hook.type !== 'command' || typeof hook.command !== 'string')
    return false;
  const command = hook.command.replaceAll('\\', '/');
  return (
    /\/sonar-(?:secrets|vortex|sqaa)\/build-scripts\//.test(command) ||
    /(?:^|\s)sonar(?:\.exe)?\s+hook\s+(?:codex-prompt-submit|codex-post-tool-use|agent-session-start)\b/.test(
      command,
    )
  );
}
