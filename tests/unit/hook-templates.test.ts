// Tests for hook template generation

import { describe, it, expect } from 'bun:test';
import {
  getHookPromptTemplateUnix,
  getHookCLITemplateUnix,
  getHookPromptTemplateWindows,
  getHookCLITemplateWindows,
  getSecretPreToolTemplateUnix,
  getSecretPreToolTemplateWindows,
  getSecretPromptTemplateUnix,
  getSecretPromptTemplateWindows
} from '../../src/bootstrap/hook-templates.js';

describe('Prompt Hook Templates', () => {
  it('Unix prompt hook: bash shebang, SonarQube branding, verify command, JSON output', () => {
    const template = getHookPromptTemplateUnix();

    expect(template.startsWith('#!/bin/bash')).toBe(true);
    expect(template.includes('SonarQube Analysis Hook')).toBe(true);
    expect(template.includes('sonar verify --file')).toBe(true);
    expect(template.includes('hookSpecificOutput')).toBe(true);
    expect(template.includes('hookEventName')).toBe(true);
    expect(template.includes('Platform: Unix')).toBe(true);
  });

  it('Windows prompt hook: PowerShell, ConvertFrom-Json, JSON output, Windows platform', () => {
    const template = getHookPromptTemplateWindows();

    expect(template.includes('#!/usr/bin/env pwsh') || template.includes('powershell')).toBe(true);
    expect(template.includes('ConvertFrom-Json')).toBe(true);
    expect(template.includes('sonar verify --file')).toBe(true);
    expect(template.includes('ConvertTo-Json')).toBe(true);
    expect(template.includes('Platform: Windows')).toBe(true);
  });
});

describe('CLI Hook Templates', () => {
  it('Unix CLI hook: bash shebang, Edit/Write check, file verification, sonar command', () => {
    const template = getHookCLITemplateUnix();

    expect(template.startsWith('#!/bin/bash')).toBe(true);
    expect(template.includes('Edit')).toBe(true);
    expect(template.includes('Write')).toBe(true);
    expect(template.includes('sonar verify')).toBe(true);
    expect(template.includes('if [ -f')).toBe(true);
  });

  it('Windows CLI hook: PowerShell script with file operations', () => {
    const template = getHookCLITemplateWindows();

    expect(template.length).toBeGreaterThan(100);
    expect(typeof template).toBe('string');
  });
});

describe('Secret Scanning Hook Templates', () => {
  it('PreTool Unix hook: bash shebang for blocking Read operations on secrets', () => {
    const template = getSecretPreToolTemplateUnix();

    expect(template.startsWith('#!/bin/bash')).toBe(true);
    expect(template.length).toBeGreaterThan(50);
  });

  it('PreTool Windows hook: PowerShell for blocking Read operations', () => {
    const template = getSecretPreToolTemplateWindows();

    expect(template.length).toBeGreaterThan(50);
    expect(typeof template).toBe('string');
  });

  it('UserPromptSubmit Unix hook: bash shebang for scanning prompts', () => {
    const template = getSecretPromptTemplateUnix();

    expect(template.startsWith('#!/bin/bash')).toBe(true);
    expect(template.length).toBeGreaterThan(50);
  });

  it('UserPromptSubmit Windows hook: PowerShell for scanning prompts', () => {
    const template = getSecretPromptTemplateWindows();

    expect(template.length).toBeGreaterThan(50);
    expect(typeof template).toBe('string');
  });
});

describe('Template Integrity', () => {
  it('All 8 templates are valid non-empty strings with distinct content', () => {
    const templates = [
      getHookPromptTemplateUnix(),
      getHookCLITemplateUnix(),
      getHookPromptTemplateWindows(),
      getHookCLITemplateWindows(),
      getSecretPreToolTemplateUnix(),
      getSecretPreToolTemplateWindows(),
      getSecretPromptTemplateUnix(),
      getSecretPromptTemplateWindows()
    ];

    const uniqueContents = new Set(templates);

    templates.forEach((template) => {
      expect(template.length).toBeGreaterThan(0);
      expect(typeof template).toBe('string');
    });

    expect(uniqueContents.size).toBe(8); // All templates are different
  });
});
