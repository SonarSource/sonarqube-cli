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

export interface IntegrateAgentOptions {
  project?: string;
  nonInteractive?: boolean;
  global?: boolean;
  /** Skip the sonar-context-augmentation install/init/skill step. */
  skipContext?: boolean;
}

export interface HookCommand {
  type: 'command';
  command: string;
  timeout: number;
}

export interface HookConfig {
  matcher: string;
  hooks: HookCommand[];
}

export interface HooksDocument {
  hooks?: Record<string, HookConfig[] | undefined>;
  [key: string]: unknown;
}

export interface ManagedHookEntry {
  eventType: string;
  marker: string;
  hookConfig: HookConfig;
}
