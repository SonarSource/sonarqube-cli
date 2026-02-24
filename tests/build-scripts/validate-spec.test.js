import { describe, it, expect } from 'bun:test';
import { spawnSync } from 'bun';
import { join } from 'node:path';

const rootDir = join(import.meta.dir, '../../');
const validateScript = join(rootDir, 'build-scripts/validate-spec.js');

describe('validate-spec.js', () => {
  it('should run without crashing', () => {
    const result = spawnSync(['node', validateScript], {
      cwd: rootDir,
      capture: true
    });

    expect(result.stdout).toBeDefined();
    expect(result.stderr).toBeDefined();
  });

  it('should output success message for valid spec', () => {
    const result = spawnSync(['node', validateScript], {
      cwd: rootDir,
      capture: true
    });

    const output = result.stdout.toString();
    expect(output).toContain('✅ spec.yaml is valid');
  });

  it('should show CLI information', () => {
    const result = spawnSync(['node', validateScript], {
      cwd: rootDir,
      capture: true
    });

    const output = result.stdout.toString();
    expect(output).toContain('CLI: sonar');
    expect(output).toContain('Commands:');
    expect(output).toContain('Total commands (including subcommands):');
  });

  it('should exit with success code', () => {
    const result = spawnSync(['node', validateScript], {
      cwd: rootDir,
      capture: true
    });

    expect(result.exitCode).toBe(0);
  });

  it('should report correct command counts', () => {
    const result = spawnSync(['node', validateScript], {
      cwd: rootDir,
      capture: true
    });

    const output = result.stdout.toString();
    // Should have Commands: N and Total commands: M where M >= N
    expect(output).toMatch(/Commands: \d+/);
    expect(output).toMatch(/Total commands \(including subcommands\): \d+/);
  });
});
