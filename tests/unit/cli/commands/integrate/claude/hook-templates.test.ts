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

// Tests for hook template generation — thin launcher format

import { describe, expect, it } from 'bun:test';

import {
  UNIX_SONAR_COMMAND_GUARD,
  WINDOWS_SONAR_COMMAND_GUARD,
} from '../../../../../../src/cli/commands/integrate/_common/hooks';
import {
  getSecretPreToolTemplateUnix,
  getSecretPreToolTemplateWindows,
  getSecretPromptTemplateUnix,
  getSecretPromptTemplateWindows,
} from '../../../../../../src/cli/commands/integrate/claude/hook-templates';

describe('Secret Scanning Hook Templates', () => {
  it('PreTool Unix hook: bash shebang, delegates to sonar hook', () => {
    const template = getSecretPreToolTemplateUnix();

    expect(template.startsWith('#!/bin/bash')).toBe(true);
    expect(template.includes('sonar hook claude-pre-tool-use')).toBe(true);
    expect(template.includes(UNIX_SONAR_COMMAND_GUARD)).toBe(true);
  });

  it('PreTool Unix hook: no embedded business logic', () => {
    const template = getSecretPreToolTemplateUnix();

    expect(template.includes('sonar analyze')).toBe(false);
    expect(template.includes('sed -n')).toBe(false);
    expect(template.includes('permissionDecision')).toBe(false);
  });

  it('PreTool Windows hook: delegates to sonar hook', () => {
    const template = getSecretPreToolTemplateWindows();

    expect(template.includes('sonar hook claude-pre-tool-use')).toBe(true);
    expect(template.includes(WINDOWS_SONAR_COMMAND_GUARD)).toBe(true);
  });

  it('UserPromptSubmit Unix hook: bash shebang, delegates to sonar hook', () => {
    const template = getSecretPromptTemplateUnix();

    expect(template.startsWith('#!/bin/bash')).toBe(true);
    expect(template.includes('sonar hook claude-prompt-submit')).toBe(true);
    expect(template.includes(UNIX_SONAR_COMMAND_GUARD)).toBe(true);
  });

  it('UserPromptSubmit Unix hook: no embedded business logic', () => {
    const template = getSecretPromptTemplateUnix();

    expect(template.includes('sonar analyze')).toBe(false);
    expect(template.includes('mktemp')).toBe(false);
  });

  it('UserPromptSubmit Windows hook: delegates to sonar hook', () => {
    const template = getSecretPromptTemplateWindows();

    expect(template.includes('sonar hook claude-prompt-submit')).toBe(true);
    expect(template.includes(WINDOWS_SONAR_COMMAND_GUARD)).toBe(true);
  });
});

describe('Template Integrity', () => {
  it('All secret templates are valid non-empty strings with distinct content', () => {
    const templates = [
      getSecretPreToolTemplateUnix(),
      getSecretPreToolTemplateWindows(),
      getSecretPromptTemplateUnix(),
      getSecretPromptTemplateWindows(),
    ];

    const uniqueContents = new Set(templates);

    templates.forEach((template) => {
      expect(template.length).toBeGreaterThan(0);
      expect(typeof template).toBe('string');
    });

    expect(uniqueContents.size).toBe(templates.length);
  });

  it('No template references old sonar secret check command', () => {
    const templates = [
      getSecretPreToolTemplateUnix(),
      getSecretPreToolTemplateWindows(),
      getSecretPromptTemplateUnix(),
      getSecretPromptTemplateWindows(),
    ];

    templates.forEach((template) => {
      expect(template.includes('sonar secret check')).toBe(false);
    });
  });
});
