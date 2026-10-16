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

import { rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

type Handler = (event: unknown, ctx: unknown) => unknown;
type Step = { event: string; payload?: unknown } | { remove: string };

interface DriverInput {
  extensionPath: string;
  cwd: string;
  sessionId: string;
  sessionIdThrows?: boolean;
  entries?: unknown[];
  steps: Step[];
}

const input = JSON.parse(await Bun.stdin.text()) as DriverInput;
const loaded = (await import(pathToFileURL(input.extensionPath).href)) as {
  default: (pi: {
    on: (name: string, handler: Handler) => void;
    sendMessage: (message: unknown) => void;
  }) => void;
};

const handlers = new Map<string, Handler>();
const sentMessages: unknown[] = [];
loaded.default({
  on: (name, handler) => handlers.set(name, handler),
  sendMessage: (message) => sentMessages.push(message),
});

const ctx = {
  cwd: input.cwd,
  sessionManager: {
    getSessionId: () => {
      if (input.sessionIdThrows) throw new Error('no session');
      return input.sessionId;
    },
    getEntries: () => input.entries ?? [],
  },
};
const results: unknown[] = [];
for (const step of input.steps) {
  if ('remove' in step) {
    rmSync(step.remove);
    results.push(null);
    continue;
  }
  const handler = handlers.get(step.event);
  if (!handler) {
    throw new Error(`The extension registered no handler for ${step.event}`);
  }
  results.push((await handler(step.payload, ctx)) ?? null);
}

process.stdout.write(JSON.stringify({ registered: [...handlers.keys()], results, sentMessages }));
process.exit(0);
