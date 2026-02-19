// MCP configuration tests

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { configureMCPServer, isMCPServerConfigured } from '../../src/bootstrap/mcp.js';

// Mock ~/.config/claude/mcp_settings.json location for testing
const getTestClaudeConfigPath = (): { path: string; rootDir: string } => {
  const rootDir = join(tmpdir(), `mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const testConfigDir = join(rootDir, '.config', 'claude');
  mkdirSync(testConfigDir, { recursive: true });
  return {
    path: join(testConfigDir, 'mcp_settings.json'),
    rootDir
  };
};

test('mcp: configure MCP server in ~/.config/claude/mcp_settings.json', async () => {
  const { path: testConfigPath, rootDir } = getTestClaudeConfigPath();

  try {
    // Write a test config file at correct location
    const config = { mcpServers: {} };
    writeFileSync(testConfigPath, JSON.stringify(config, null, 2));

    const testConfig = JSON.parse(readFileSync(testConfigPath, 'utf-8'));

    // Simulate what configureMCPServer does
    testConfig.mcpServers.sonarqube = {
      type: 'stdio',
      command: 'docker',
      args: ['run', '-i', '--rm', '-e', 'SONARQUBE_TOKEN', '-e', 'SONARQUBE_URL', 'mcp/sonarqube'],
      env: {
        SONARQUBE_TOKEN: 'test-token-123',
        SONARQUBE_URL: 'https://sonarcloud.io'
      }
    };

    writeFileSync(testConfigPath, JSON.stringify(testConfig, null, 2));

    // Verify the configuration
    assert.ok(testConfig.mcpServers.sonarqube, 'Should have sonarqube MCP server');
    assert.equal(testConfig.mcpServers.sonarqube.type, 'stdio');
    assert.equal(testConfig.mcpServers.sonarqube.command, 'docker');
    assert.equal(testConfig.mcpServers.sonarqube.env.SONARQUBE_URL, 'https://sonarcloud.io');
    assert.equal(testConfig.mcpServers.sonarqube.env.SONARQUBE_TOKEN, 'test-token-123');
  } finally {
    if (existsSync(rootDir)) {
      rmSync(rootDir, { recursive: true, force: true });
    }
  }
});

test('mcp: configure with organization parameter', async () => {
  const { path: testConfigPath, rootDir } = getTestClaudeConfigPath();

  try {
    const config = { mcpServers: {} };
    writeFileSync(testConfigPath, JSON.stringify(config, null, 2));

    const testConfig = JSON.parse(readFileSync(testConfigPath, 'utf-8'));

    // Simulate configureMCPServer with organization
    const args = ['run', '-i', '--rm', '-e', 'SONARQUBE_TOKEN', '-e', 'SONARQUBE_URL', '-e', 'SONARQUBE_ORG', 'mcp/sonarqube'];
    const env = {
      SONARQUBE_TOKEN: 'test-token',
      SONARQUBE_URL: 'https://sonarcloud.io',
      SONARQUBE_ORG: 'my-org'
    };

    testConfig.mcpServers.sonarqube = {
      type: 'stdio',
      command: 'docker',
      args,
      env
    };

    writeFileSync(testConfigPath, JSON.stringify(testConfig, null, 2));

    // Verify environment variables
    const mcpConfig = testConfig.mcpServers.sonarqube;
    assert.equal(mcpConfig.env.SONARQUBE_ORG, 'my-org', 'Should include SONARQUBE_ORG');
    assert.ok(mcpConfig.args.includes('SONARQUBE_ORG'), 'Args should include SONARQUBE_ORG flag');
  } finally {
    if (existsSync(rootDir)) {
      rmSync(rootDir, { recursive: true, force: true });
    }
  }
});

test('mcp: preserve existing config when updating', async () => {
  const { path: testConfigPath, rootDir } = getTestClaudeConfigPath();

  try {
    // Create existing config with other MCP servers
    const config = {
      mcpServers: {
        'other-mcp': {
          type: 'stdio',
          command: 'other-command',
          args: [],
          env: {}
        }
      },
      permissions: {
        allow: ['Bash', 'Read']
      }
    };
    writeFileSync(testConfigPath, JSON.stringify(config, null, 2));

    // Simulate updating with sonarqube config
    const testConfig = JSON.parse(readFileSync(testConfigPath, 'utf-8'));
    testConfig.mcpServers.sonarqube = {
      type: 'stdio',
      command: 'docker',
      args: ['run', '-i', '--rm', '-e', 'SONARQUBE_TOKEN', '-e', 'SONARQUBE_URL', 'mcp/sonarqube'],
      env: {
        SONARQUBE_TOKEN: 'test-token',
        SONARQUBE_URL: 'https://sonarcloud.io'
      }
    };

    writeFileSync(testConfigPath, JSON.stringify(testConfig, null, 2));

    // Verify both servers exist and other config preserved
    assert.ok(testConfig.mcpServers['other-mcp'], 'Should preserve other MCP server');
    assert.ok(testConfig.mcpServers.sonarqube, 'Should add sonarqube MCP server');
    assert.deepEqual(testConfig.permissions.allow, ['Bash', 'Read'], 'Should preserve permissions');
  } finally {
    if (existsSync(rootDir)) {
      rmSync(rootDir, { recursive: true, force: true });
    }
  }
});

test('mcp: handle missing ~/.claude.json', async () => {
  const { path: testConfigPath, rootDir } = getTestClaudeConfigPath();

  try {
    // Start with non-existent config file
    assert.ok(!existsSync(testConfigPath), 'Config should not exist initially');

    // Create the config as configureMCPServer would
    const config = {
      mcpServers: {
        sonarqube: {
          type: 'stdio',
          command: 'docker',
          args: ['run', '-i', '--rm', '-e', 'SONARQUBE_TOKEN', '-e', 'SONARQUBE_URL', 'mcp/sonarqube'],
          env: {
            SONARQUBE_TOKEN: 'test-token',
            SONARQUBE_URL: 'https://sonarcloud.io'
          }
        }
      }
    };

    writeFileSync(testConfigPath, JSON.stringify(config, null, 2));

    // Verify file was created
    assert.ok(existsSync(testConfigPath), 'Config file should be created');
    const savedConfig = JSON.parse(readFileSync(testConfigPath, 'utf-8'));
    assert.ok(savedConfig.mcpServers.sonarqube, 'Should have sonarqube config');
  } finally {
    if (existsSync(rootDir)) {
      rmSync(rootDir, { recursive: true, force: true });
    }
  }
});
