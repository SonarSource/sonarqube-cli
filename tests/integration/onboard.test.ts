// Integration test for onboarding flow

import { it, expect } from 'bun:test';

import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PROJECT_ROOT = join(import.meta.dir, '../..');
import { discoverProject } from '../../src/bootstrap/discovery.js';
import { loadConfig, saveConfig, newConfig } from '../../src/bootstrap/config.js';
import { installHooks, areHooksInstalled } from '../../src/bootstrap/hooks.js';

it('integration: full onboarding flow', async () => {
  const testDir = join(tmpdir(), 'sonarqube-cli-test-integration-' + Date.now());
  mkdirSync(testDir, { recursive: true });

  try {
    // Step 1: Create sonar-project.properties
    const propsContent = `
sonar.host.url=https://sonarcloud.io
sonar.projectKey=test_project
sonar.organization=test-org
`;
    writeFileSync(join(testDir, 'sonar-project.properties'), propsContent);

    // Step 2: Discover project
    const projectInfo = await discoverProject(testDir);

    expect(projectInfo.hasSonarProps).toBe(true);
    expect(projectInfo.sonarPropsData!.hostURL).toBe('https://sonarcloud.io');
    expect(projectInfo.sonarPropsData!.projectKey).toBe('test_project');

    // Step 3: Create and save configuration
    const config = newConfig(
      projectInfo.root,
      projectInfo.name,
      projectInfo.sonarPropsData!.hostURL,
      projectInfo.sonarPropsData!.projectKey,
      projectInfo.sonarPropsData!.organization
    );

    await saveConfig(projectInfo.root, config);

    // Verify config was saved
    const configPath = join(projectInfo.root, '.sonarqube', 'config.json');
    expect(existsSync(configPath)).toBe(true);

    // Step 4: Load config to verify
    const loadedConfig = await loadConfig(projectInfo.root);
    expect(loadedConfig).toBeDefined();
    expect(loadedConfig!.sonarqube.serverUrl).toBe('https://sonarcloud.io');
    expect(loadedConfig!.sonarqube.projectKey).toBe('test_project');
    expect(loadedConfig!.sonarqube.organization).toBe('test-org');

    // Step 5: Install hooks
    await installHooks(projectInfo.root, 'prompt');

    // Verify hooks
    const installed = await areHooksInstalled(projectInfo.root);
    expect(installed).toBe(true);

    // Verify hook script exists
    const hookScript = join(projectInfo.root, '.claude', 'hooks', 'sonar-prompt.sh');
    expect(existsSync(hookScript)).toBe(true);

    // Verify settings exists
    const settingsPath = join(projectInfo.root, '.claude', 'settings.json');
    expect(existsSync(settingsPath)).toBe(true);

    console.log('✅ Full onboarding flow completed successfully');
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

it('integration: onboard with existing .sonarlint config', async () => {
  const testDir = join(tmpdir(), 'sonarqube-cli-test-sonarlint-' + Date.now());
  const sonarlintDir = join(testDir, '.sonarlint');
  mkdirSync(sonarlintDir, { recursive: true });

  try {
    // Create .sonarlint/connectedMode.json
    const configContent = {
      sonarQubeUri: 'https://sonarqube.example.com',
      projectKey: 'example_project',
      organization: 'example-org'
    };

    writeFileSync(
      join(sonarlintDir, 'connectedMode.json'),
      JSON.stringify(configContent, null, 2)
    );

    // Discover
    const projectInfo = await discoverProject(testDir);

    expect(projectInfo.hasSonarLintConfig).toBe(true);
    expect(projectInfo.sonarLintData!.serverURL).toBe('https://sonarqube.example.com');

    // Create config from discovered data
    const config = newConfig(
      projectInfo.root,
      projectInfo.name,
      projectInfo.sonarLintData!.serverURL,
      projectInfo.sonarLintData!.projectKey,
      projectInfo.sonarLintData!.organization
    );

    await saveConfig(projectInfo.root, config);

    // Verify
    const loaded = await loadConfig(projectInfo.root);
    expect(loaded!.sonarqube.serverUrl).toBe('https://sonarqube.example.com');

    console.log('✅ Onboarding with existing .sonarlint config completed');
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

it('integration: config persistence across multiple operations', async () => {
  const testDir = join(tmpdir(), 'sonarqube-cli-test-persistence-' + Date.now());
  mkdirSync(testDir, { recursive: true });

  try {
    // Create initial config
    const config1 = newConfig(testDir, 'proj1', 'https://server1.com', 'key1', 'org1');
    await saveConfig(testDir, config1);

    // Load and verify
    let loaded = await loadConfig(testDir);
    expect(loaded!.sonarqube.projectKey).toBe('key1');

    // Install hooks
    await installHooks(testDir, 'prompt');

    // Load config again (should still exist)
    loaded = await loadConfig(testDir);
    expect(loaded!.sonarqube.projectKey).toBe('key1');

    // Update config
    const config2 = newConfig(testDir, 'proj1', 'https://server2.com', 'key2', 'org2');
    await saveConfig(testDir, config2);

    // Load and verify update
    loaded = await loadConfig(testDir);
    expect(loaded!.sonarqube.projectKey).toBe('key2');
    expect(loaded!.sonarqube.serverUrl).toBe('https://server2.com');

    // Hooks should still be installed
    const installed = await areHooksInstalled(testDir);
    expect(installed).toBe(true);

    console.log('✅ Config persistence test completed');
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

it('integration: auth login process exits after token delivered to loopback server', async () => {
  // Regression test: process must exit quickly after completing the browser auth flow.
  // Previously the process would hang due to open handles (loopback server, stdin stream).
  //
  // Strategy:
  //   1. Spawn `sonar auth login` against a fake server (no cached token in keychain)
  //   2. Read stdout until the loopback URL appears — extract the port
  //   3. Write "\n" to stdin to pass pressAnyKeyPrompt
  //   4. POST the token directly to the loopback server (simulates browser callback)
  //   5. Assert the process exits within 5 seconds
  //
  // Exit code will be 1 (token validation against fake server fails with DNS error).
  // That is expected — what matters is the process exits.

  const fakeServer = `https://sonar-exit-test-${Date.now()}.invalid`;

  const proc = Bun.spawn(
    ['bun', 'run', 'src/index.ts', 'auth', 'login', '--server', fakeServer],
    {
      stdout: 'pipe',
      stdin: 'ignore',
      stderr: 'pipe',
      cwd: PROJECT_ROOT,
      env: { ...process.env, CI: 'true', SONAR_CLI_DISABLE_KEYCHAIN: 'true' },
    }
  );

  // Read stdout until the loopback URL appears
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let port: number | undefined;

  while (!port) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Loopback URL not found in stdout within 5s')), 5000)
      ),
    ]);
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const match = buffer.match(/port=(\d+)/);
    if (match) port = parseInt(match[1]);
  }

  expect(port).toBeDefined();

  // POST the token — simulates SonarCloud redirecting to the loopback server
  // pressAnyKeyPrompt is skipped automatically when CI=true
  await fetch(`http://127.0.0.1:${port}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'squ_integration_test_token' }),
  });

  // Process must exit within 5 seconds
  const exitCode = await Promise.race([
    proc.exited,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Process hung — did not exit within 5s')), 5000)
    ),
  ]);

  expect(typeof exitCode).toBe('number');
}, { timeout: 15000 });

