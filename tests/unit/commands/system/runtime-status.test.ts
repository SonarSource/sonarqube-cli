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

import { expect, it } from 'bun:test';

import {
  runtimeHealthMessage,
  runtimeStatusLine,
} from '@/core/host/environment/runtime-health-messages.ts';

it('reports a timed-out runtime and recommends checking it', () => {
  const runtime = {
    status: 'not_ready' as const,
    runtime: 'docker' as const,
    viaWsl: false,
    reason: 'timeout' as const,
  };

  expect(runtimeStatusLine(runtime)).toBe('NOT RESPONDING (docker)');
  expect(runtimeHealthMessage(runtime)).toBe(
    'docker is not responding to the runtime check. The MCP launcher may wait for it.',
  );
});

it('includes WSL in the shared warning', () => {
  expect(runtimeHealthMessage({ status: 'not_ready', runtime: 'podman', viaWsl: true })).toBe(
    'SonarQube MCP Server cannot start because podman via WSL is not ready. Start or repair it.',
  );
});
