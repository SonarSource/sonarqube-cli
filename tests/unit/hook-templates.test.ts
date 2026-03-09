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

// Tests for hook template generation

import { describe, it, expect } from 'bun:test';
import {
  getSecretPreToolTemplateUnix,
  getSecretPreToolTemplateWindows,
  getSecretPromptTemplateUnix,
  getSecretPromptTemplateWindows,
  getA3sPostToolTemplateUnix,
  getA3sPostToolTemplateWindows,
} from '../../src/cli/commands/integrate/claude/hook-templates';

describe('Secret Scanning Hook Templates', () => {
  it('PreTool Unix hook: bash shebang, sonar analyze command, exit code 51', () => {
    const template = getSecretPreToolTemplateUnix();

    expect(template.startsWith('#!/bin/bash')).toBe(true);
    expect(template.includes('sonar analyze secrets --file')).toBe(true);
    expect(template.includes('exit_code -eq 51')).toBe(true);
    expect(template.includes('permissionDecision')).toBe(true);
  });

  it('PreTool Windows hook: PowerShell, sonar analyze command, exit code 51', () => {
    const template = getSecretPreToolTemplateWindows();

    expect(template.includes('sonar analyze secrets --file')).toBe(true);
    expect(template.includes('$exitCode -eq 51')).toBe(true);
    expect(typeof template).toBe('string');
  });

  it('UserPromptSubmit Unix hook: bash shebang, sonar analyze command, exit code 51', () => {
    const template = getSecretPromptTemplateUnix();

    expect(template.startsWith('#!/bin/bash')).toBe(true);
    expect(template.includes('sonar analyze --file')).toBe(true);
    expect(template.includes('exit_code -eq 51')).toBe(true);
  });

  it('UserPromptSubmit Windows hook: PowerShell, sonar analyze command, exit code 51', () => {
    const template = getSecretPromptTemplateWindows();

    expect(template.includes('sonar analyze --file')).toBe(true);
    expect(template.includes('$exitCode -eq 51')).toBe(true);
    expect(typeof template).toBe('string');
  });
});

describe('A3S PostToolUse Hook Templates', () => {
  it('PostTool Unix hook: bash shebang, sonar analyze a3s command, handles Edit and Write tools', () => {
    const template = getA3sPostToolTemplateUnix();

    expect(template.startsWith('#!/bin/bash')).toBe(true);
    expect(template.includes('sonar analyze a3s --file')).toBe(true);
    expect(template.includes('"Edit"')).toBe(true);
    expect(template.includes('"Write"')).toBe(true);
  });

  it('PostTool Unix hook: non-blocking (never blocks file operations)', () => {
    const template = getA3sPostToolTemplateUnix();

    // Must not emit permissionDecision — PostToolUse is informational only
    expect(template.includes('permissionDecision')).toBe(false);
    // Should be non-blocking (uses || true or similar)
    expect(template.includes('|| true') || template.includes('2>/dev/null')).toBe(true);
  });

  it('PostTool Windows hook: PowerShell, sonar analyze a3s command, handles Edit and Write tools', () => {
    const template = getA3sPostToolTemplateWindows();

    expect(typeof template).toBe('string');
    expect(template.includes('sonar analyze a3s')).toBe(true);
    expect(template.includes('"Edit"') || template.includes('-ne "Edit"')).toBe(true);
    expect(template.includes('"Write"') || template.includes('-ne "Write"')).toBe(true);
  });

  it('PostTool Windows hook: non-blocking (never blocks file operations)', () => {
    const template = getA3sPostToolTemplateWindows();

    expect(template.includes('permissionDecision')).toBe(false);
  });
});

describe('Template Integrity', () => {
  it('All 6 templates are valid non-empty strings with distinct content', () => {
    const templates = [
      getSecretPreToolTemplateUnix(),
      getSecretPreToolTemplateWindows(),
      getSecretPromptTemplateUnix(),
      getSecretPromptTemplateWindows(),
      getA3sPostToolTemplateUnix(),
      getA3sPostToolTemplateWindows(),
    ];

    const uniqueContents = new Set(templates);

    templates.forEach((template) => {
      expect(template.length).toBeGreaterThan(0);
      expect(typeof template).toBe('string');
    });

    expect(uniqueContents.size).toBe(6); // All templates are different
  });

  it('No template references old sonar secret check command', () => {
    const templates = [
      getSecretPreToolTemplateUnix(),
      getSecretPreToolTemplateWindows(),
      getSecretPromptTemplateUnix(),
      getSecretPromptTemplateWindows(),
      getA3sPostToolTemplateUnix(),
      getA3sPostToolTemplateWindows(),
    ];

    templates.forEach((template) => {
      expect(template.includes('sonar secret check')).toBe(false);
    });
  });

  it('A3S templates use sonar analyze a3s, secrets templates use sonar analyze', () => {
    expect(getA3sPostToolTemplateUnix().includes('sonar analyze a3s')).toBe(true);
    expect(getA3sPostToolTemplateWindows().includes('sonar analyze a3s')).toBe(true);

    // Secrets templates should NOT call sonar analyze a3s
    expect(getSecretPreToolTemplateUnix().includes('sonar analyze a3s')).toBe(false);
    expect(getSecretPromptTemplateUnix().includes('sonar analyze a3s')).toBe(false);
  });
});
