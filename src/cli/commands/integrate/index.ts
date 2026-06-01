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

import { createIntegrationRegistry } from './_common/registry/core';
import { claudeIntegration } from './claude/declaration';
import { codexIntegration } from './codex/declaration';
import { copilotIntegration } from './copilot/declaration';
import { GIT_INTEGRATIONS } from './git/tools';

export const ALL_INTEGRATIONS = [
  claudeIntegration,
  copilotIntegration,
  codexIntegration,
  ...GIT_INTEGRATIONS,
] as const;

export const supportedIntegrations = createIntegrationRegistry(ALL_INTEGRATIONS);
