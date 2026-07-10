import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { ResolvedAuth } from '../../../src/lib/auth-resolver';
import { RUNTIME_PROJECT_CACHE_FILE } from '../../../src/lib/config-constants';
import { detectInstalledAgents, parseAgentFilter } from '../../../src/lib/detect-installed-agents';
import { resolveRuntimeProjectKey } from '../../../src/lib/runtime-project-context';

const cloudAuth: ResolvedAuth = {
  connectionType: 'cloud',
  serverUrl: 'https://sonarcloud.io',
  orgKey: 'my-org',
  token: 'token',
};

describe('detectInstalledAgents', () => {
  test('detects cursor when ~/.cursor exists', () => {
    const home = homedir();
    const cursorDir = join(home, '.cursor');
    const created = !existsSync(cursorDir);
    if (created) {
      mkdirSync(cursorDir, { recursive: true });
    }

    try {
      expect(detectInstalledAgents(['cursor'])).toEqual(['cursor']);
    } finally {
      if (created) {
        rmSync(cursorDir, { recursive: true, force: true });
      }
    }
  });

  test('parseAgentFilter rejects unknown agents', () => {
    expect(() => parseAgentFilter('cursor,unknown-agent')).toThrow(/Unknown agent/);
  });
});

describe('resolveRuntimeProjectKey', () => {
  let tmpRoot: string;
  let originalSonarUserHome: string | undefined;

  beforeEach(() => {
    originalSonarUserHome = process.env.SONAR_USER_HOME;
    tmpRoot = mkdtempSync(join(tmpdir(), 'sonar-runtime-project-'));
    process.env.SONAR_USER_HOME = join(tmpRoot, 'sonar-home');
    mkdirSync(process.env.SONAR_USER_HOME, { recursive: true });
    rmSync(RUNTIME_PROJECT_CACHE_FILE, { force: true });
  });

  afterEach(() => {
    if (originalSonarUserHome === undefined) {
      delete process.env.SONAR_USER_HOME;
    } else {
      process.env.SONAR_USER_HOME = originalSonarUserHome;
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('discovers project key from sonar-project.properties', async () => {
    const repoRoot = join(tmpRoot, 'repo');
    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(
      join(repoRoot, 'sonar-project.properties'),
      'sonar.projectKey=my-org:demo\nsonar.organization=my-org\n',
      'utf-8',
    );

    const projectKey = await resolveRuntimeProjectKey(repoRoot, cloudAuth);

    expect(projectKey).toBe('my-org:demo');
  });

  test('returns null and caches negative result when no Sonar config exists', async () => {
    const repoRoot = join(tmpRoot, 'empty-repo');
    mkdirSync(repoRoot, { recursive: true });

    expect(await resolveRuntimeProjectKey(repoRoot, cloudAuth)).toBeNull();
    expect(await resolveRuntimeProjectKey(repoRoot, cloudAuth)).toBeNull();
    expect(existsSync(RUNTIME_PROJECT_CACHE_FILE)).toBe(true);
  });
});
