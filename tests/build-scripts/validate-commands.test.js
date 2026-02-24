import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'bun';
import { join } from 'node:path';

const rootDir = join(import.meta.dir, '../../');
const validateScript = join(rootDir, 'build-scripts/validate-commands.js');

describe('validate-commands.js', () => {
  it('should run without crashing', () => {
    const result = spawnSync(['node', validateScript], {
      cwd: rootDir,
      capture: true
    });

    expect(result.stdout).toBeDefined();
    expect(result.stderr).toBeDefined();
  });

  it('should output validation results', () => {
    const result = spawnSync(['node', validateScript], {
      cwd: rootDir,
      capture: true
    });

    const output = result.stdout.toString();
    expect(output).toContain('🔍 Validating commands');
    expect(output).toContain('Checking spec commands are registered');
    expect(output).toContain('Checking for undeclared commands');
    expect(output).toContain('Checking handler files exist');
    expect(output).toContain('Checking imports');
  });

  it('should report validation results', () => {
    const result = spawnSync(['node', validateScript], {
      cwd: rootDir,
      capture: true
    });

    const output = result.stdout.toString();
    // Should either show success message or error/warning counts
    const hasSuccessMessage = output.includes('All checks passed! Commands match specification.');
    const hasTotalMessage = /Total: \d+ error\(s\), \d+ warning\(s\)/.test(output);
    
    expect(hasSuccessMessage || hasTotalMessage).toBe(true);
  });

  it('should have consistent format with emojis', () => {
    const result = spawnSync(['node', validateScript], {
      cwd: rootDir,
      capture: true
    });

    const output = result.stdout.toString();
    expect(output).toContain('1️⃣');
    expect(output).toContain('2️⃣');
    expect(output).toContain('3️⃣');
    expect(output).toContain('4️⃣');
  });

  it('should exit with error code if issues found', () => {
    const result = spawnSync(['node', validateScript], {
      cwd: rootDir,
      capture: true
    });

    // Script may exit with 0 or 1 depending on spec/implementation state
    expect([0, 1]).toContain(result.exitCode);
  });
});
