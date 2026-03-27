#!/usr/bin/env node

/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

import * as Sentry from '@sentry/bun';
import { COMMAND_TREE } from './cli/command-tree';
import * as postUpdate from './lib/post-update';
import { loadState } from './lib/state-manager';
import { initSentry } from './lib/sentry';

const SENTRY_FLUSH_TIMEOUT = 2000;

const state = loadState();
initSentry(state);

await postUpdate.runPostUpdateActions();

await COMMAND_TREE.parseAsync(process.argv);
await Sentry.flush(SENTRY_FLUSH_TIMEOUT);
