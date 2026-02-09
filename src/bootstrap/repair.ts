// Repair orchestrator - fixes configuration issues

import { generateTokenViaBrowser, saveToken, validateToken, deleteToken } from './auth.js';
import { pullMcpImage } from './docker.js';
import { installHooks, type HookType } from './hooks.js';
import { cleanupProjectMCPConfig } from './mcp.js';
import type { HealthCheckResult } from './health.js';

/**
 * Run repair actions based on health check results
 */
export async function runRepair(
  serverURL: string,
  projectRoot: string,
  healthResult: HealthCheckResult,
  projectKey?: string,
  organization?: string,
  hookType: HookType = 'prompt'
): Promise<void> {
  let token = '';

  // Fix token if invalid
  if (!healthResult.tokenValid) {
    console.log('\n→ 🔑 Obtaining access token...');

    // Delete old token
    try {
      await deleteToken(serverURL);
    } catch {
      // Ignore errors
    }

    // Generate new token
    token = await generateTokenViaBrowser(serverURL);

    // Validate new token
    const valid = await validateToken(serverURL, token);
    if (!valid) {
      throw new Error('Generated token is invalid');
    }

    // Save to keychain
    await saveToken(serverURL, token);
    console.log('   ✓ Token saved to keychain');
  }

  // Fix Docker image if missing
  if (!healthResult.dockerImagePresent) {
    console.log('\n→ 📦 Installing MCP Server...');
    await pullMcpImage();
  }

  // Fix MCP configuration in ~/.claude.json
  console.log('\n→ ⚙️  Configuring MCP Server...');

  // Clean up old project-specific MCP config if it exists
  await cleanupProjectMCPConfig(projectRoot);

  // Need token for MCP config
  if (!token) {
    const { getToken } = await import('./auth.js');
    const storedToken = await getToken(serverURL);
    if (!storedToken) {
      throw new Error('No token available for MCP configuration');
    }
    token = storedToken;
  }

  // Import configureMCPServer for official Claude Code MCP config location
  const { configureMCPServer } = await import('./mcp.js');
  await configureMCPServer(serverURL, token, organization);
  console.log('   ✓ MCP server configured');

  // Fix hooks if not installed
  if (!healthResult.hooksInstalled) {
    console.log('\n→ 🪝 Installing hooks...');
    await installHooks(projectRoot, hookType);
    console.log('   ✓ Hooks installed');
  }
}
