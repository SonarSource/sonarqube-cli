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

import { pathToFileURL } from 'node:url';

type Handler = (event: unknown) => unknown;

interface Step {
  hook: string;
  event: unknown;
}

interface DriverInput {
  pluginPath: string;
  directory: string;
  steps: Step[];
}

const input = JSON.parse(await Bun.stdin.text()) as DriverInput;
const loaded = (await import(pathToFileURL(input.pluginPath).href)) as {
  default: { id: string; setup: (ctx: unknown) => Promise<void> };
};

const LATE_ERROR_WINDOW_MS = 200;

const handlers = new Map<string, Handler>();

function registerHook(name: string, handler: Handler): Promise<void> {
  handlers.set(name, handler);
  return Promise.resolve();
}

await loaded.default.setup({
  location: { directory: input.directory },
  tool: { hook: (name: string, handler: Handler) => registerHook(`tool.${name}`, handler) },
  session: { hook: (name: string, handler: Handler) => registerHook(`session.${name}`, handler) },
});

const results: { error: string | null; event: unknown }[] = [];
for (const step of input.steps) {
  const handler = handlers.get(step.hook);
  if (!handler) {
    throw new Error(`The plugin registered no handler for ${step.hook}`);
  }
  try {
    await handler(step.event);
    results.push({ error: null, event: step.event });
  } catch (error) {
    results.push({
      error: error instanceof Error ? error.message : String(error),
      event: step.event,
    });
  }
}

await new Promise((resolve) => setTimeout(resolve, LATE_ERROR_WINDOW_MS));

process.stdout.write(
  JSON.stringify({ id: loaded.default.id, registered: [...handlers.keys()], results }),
);
process.exit(0);
