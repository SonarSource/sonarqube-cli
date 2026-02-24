// Tests for hook template generation

import { describe, it, expect } from 'bun:test';
import {
  getSecretPreToolTemplateUnix,
  getSecretPreToolTemplateWindows,
  getSecretPromptTemplateUnix,
  getSecretPromptTemplateWindows
} from '../../src/bootstrap/hook-templates.js';

describe('Secret Scanning Hook Templates', () => {
  it('PreTool Unix hook: bash shebang, sonar analyze command, exit code 51', () => {
    const template = getSecretPreToolTemplateUnix();

    expect(template.startsWith('#!/bin/bash')).toBe(true);
    expect(template.includes('sonar analyze --file')).toBe(true);
    expect(template.includes('exit_code -eq 51')).toBe(true);
    expect(template.includes('permissionDecision')).toBe(true);
  });

  it('PreTool Windows hook: PowerShell, sonar analyze command, exit code 51', () => {
    const template = getSecretPreToolTemplateWindows();

    expect(template.includes('sonar analyze --file')).toBe(true);
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

describe('Template Integrity', () => {
  it('All 4 templates are valid non-empty strings with distinct content', () => {
    const templates = [
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

    expect(uniqueContents.size).toBe(4); // All templates are different
  });

  it('No template references old sonar secret check command', () => {
    const templates = [
      getSecretPreToolTemplateUnix(),
      getSecretPreToolTemplateWindows(),
      getSecretPromptTemplateUnix(),
      getSecretPromptTemplateWindows()
    ];

    templates.forEach((template) => {
      expect(template.includes('sonar secret check')).toBe(false);
    });
  });
});
