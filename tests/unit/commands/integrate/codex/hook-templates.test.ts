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

import { describe, expect, it } from 'bun:test';

import {
  UNIX_SONAR_COMMAND_GUARD,
  WINDOWS_SONAR_COMMAND_GUARD,
} from '../../../../../src/commands/integrate/_common/hooks.ts';
import {
  getSqaaPostToolTemplateUnix,
  getSqaaPostToolTemplateWindows,
} from '../../../../../src/commands/integrate/codex/hook-templates.ts';

describe('Codex SQAA PostToolUse Hook Templates', () => {
  it('PostTool Unix hook: delegates to codex-post-tool-use with project key', () => {
    const template = getSqaaPostToolTemplateUnix('my-project');

    expect(template.startsWith('#!/bin/bash')).toBe(true);
    expect(template.includes('sonar hook codex-post-tool-use')).toBe(true);
    expect(template.includes("--project 'my-project'")).toBe(true);
    expect(template.includes(UNIX_SONAR_COMMAND_GUARD)).toBe(true);
    expect(template.includes('sonar analyze agentic')).toBe(false);
  });

  it('PostTool Windows hook: delegates to codex-post-tool-use with project key', () => {
    const template = getSqaaPostToolTemplateWindows('my-project');

    expect(template.includes('sonar hook codex-post-tool-use')).toBe(true);
    expect(template.includes("--project 'my-project'")).toBe(true);
    expect(template.includes(WINDOWS_SONAR_COMMAND_GUARD)).toBe(true);
    expect(template.includes('sonar analyze agentic')).toBe(false);
  });
});
