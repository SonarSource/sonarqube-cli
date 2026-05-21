#!/usr/bin/env bun

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

// Main CLI entry point

import { COMMAND_TREE } from './cli/command-tree';
import * as postUpdate from './lib/post-update';
import { flushSentry } from './lib/sentry';
import { setFormattedOutputMode } from './ui';

// Activate formatted output mode early so startup messages are collected
// rather than printed to stdout when the command will produce JSON output.
// Handles both `--format json` (space-separated) and `--format=json` (equals form).
if (
  process.argv.some(
    (a, i) => (a === '--format' && process.argv[i + 1] === 'json') || a === '--format=json',
  )
) {
  setFormattedOutputMode(true);
}

await postUpdate.runPostUpdateActions();

await COMMAND_TREE.parseAsync(process.argv);
await flushSentry();
