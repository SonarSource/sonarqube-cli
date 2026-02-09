// Onboard-agent command - setup SonarQube integration for Claude Code

import { discoverProject } from '../bootstrap/discovery.js';
import { runHealthChecks } from '../bootstrap/health.js';
import { runRepair } from '../bootstrap/repair.js';
// Config is read from sonar-project.properties, no need to save separate file
import { getToken } from '../bootstrap/auth.js';
import { getAllCredentials } from '../lib/keychain.js';
import type { HookType } from '../bootstrap/hooks.js';

export interface OnboardAgentOptions {
  server?: string;
  project?: string;
  token?: string;
  org?: string;
  nonInteractive?: boolean;
  skipHooks?: boolean;
  hookType?: string;
  verbose?: boolean;
}

/**
 * Onboard-agent command handler
 */
export async function onboardAgentCommand(agent: string, options: OnboardAgentOptions): Promise<void> {
  const verbose = options.verbose || false;

  // Validate agent
  const agentNames: Record<string, string> = {
    'claude': 'Claude Code',
    'gemini': 'Gemini',
    'codex': 'Codex'
  };

  const agentName = agentNames[agent] || 'Unknown Agent';

  // Check if agent is supported
  if (agent !== 'claude') {
    console.error(`\nError: Agent "${agent}" is not yet supported.`);
    console.error('Currently supported agents: claude');
    console.error('Coming soon: gemini, codex\n');
    process.exit(1);
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`🚀 SonarQube Integration Setup for ${agentName}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Phase 1: Discovery & Validation
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Phase 1/4: Discovery & Validation');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const projectInfo = await discoverProject(process.cwd(), verbose);

  console.log(`✓ Project root: ${projectInfo.root}`);
  if (projectInfo.isGitRepo) {
    console.log(`✓ Git repository detected`);
  }

  // Determine configuration
  let serverURL = options.server;
  let projectKey = options.project;
  let organization = options.org;
  let token = options.token;

  // Use discovered configuration if available
  if (projectInfo.hasSonarProps && projectInfo.sonarPropsData) {
    serverURL = serverURL || projectInfo.sonarPropsData.hostURL;
    projectKey = projectKey || projectInfo.sonarPropsData.projectKey;
    organization = organization || projectInfo.sonarPropsData.organization;
    console.log(`✓ Found sonar-project.properties`);
  }

  if (projectInfo.hasSonarLintConfig && projectInfo.sonarLintData) {
    serverURL = serverURL || projectInfo.sonarLintData.serverURL;
    projectKey = projectKey || projectInfo.sonarLintData.projectKey;
    organization = organization || projectInfo.sonarLintData.organization;
    console.log(`✓ Found .sonarlint/connectedMode.json`);
  }

  // Try to get credentials from OS keychain if not fully provided
  if (!token || !organization || !serverURL) {
    try {
      // First, try to get token for the specific organization/server if provided
      if ((organization || serverURL) && !token) {
        const keychainToken = await getToken(serverURL || 'https://sonarcloud.io', organization);
        if (keychainToken) {
          token = keychainToken;
          console.log(`✓ Found stored credentials`);
        }
      }
      
      // If still missing values, try to find any stored SonarCloud credentials
      if (!token || !organization) {
        const credentials = await getAllCredentials();
        const sonarCloudCreds = credentials.filter(cred => 
          cred.account.startsWith('sonarcloud.io:')
        );
        
        if (sonarCloudCreds.length > 0) {
          // Use the first available SonarCloud credential
          const cred = sonarCloudCreds[0];
          const [, org] = cred.account.split(':');
          
          if (!organization) {
            organization = org;
          }
          
          if (!token) {
            token = cred.password;
          }

          if (!serverURL) {
            serverURL = 'https://sonarcloud.io';
          }
          
          console.log(`✓ Using stored credentials for organization: ${org}`);
          
          if (sonarCloudCreds.length > 1) {
            console.log(`ℹ Multiple organizations found (${sonarCloudCreds.length}). Using: ${org}`);
            console.log('  To use a different organization, specify --org');
          }
        }
      }
    } catch (error) {
      // Silently fail keychain access - will validate required values below
    }
  }

  // If organization is provided but no server URL, default to SonarCloud
  if (organization && !serverURL) {
    serverURL = 'https://sonarcloud.io';
    console.log(`✓ Organization provided, defaulting to SonarCloud`);
  }

  // Validate required parameters
  if (!serverURL) {
    console.error('\nError: Server URL is required. Use --server flag or --org flag for SonarCloud');
    process.exit(1);
  }

  if (!projectKey) {
    console.error('\nError: Project key is required. Use --project flag');
    process.exit(1);
  }

  console.log(`\nServer: ${serverURL}`);
  console.log(`Project: ${projectKey}`);
  if (organization) {
    console.log(`Organization: ${organization}`);
  }

  // If token still not found, try one more time with determined server/org
  if (!token) {
    const storedToken = await getToken(serverURL, organization);
    token = storedToken || undefined;
  }

  if (!token) {
    console.log('\n⚠️  No token found. Will generate during repair phase.');
  }

  // Phase 2: Health Check
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Phase 2/4: Health Check');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (!token) {
    console.log('⏭️  Skipping health check (no token available)');
  } else {
    const healthResult = await runHealthChecks(serverURL, token, projectKey, projectInfo.root, organization);

    if (healthResult.errors.length === 0) {
      console.log('\n✅ All checks passed! Configuration is healthy.');
      return;
    }

    console.log(`\n⚠️  Found ${healthResult.errors.length} issue(s):`);
    for (const error of healthResult.errors) {
      console.log(`   - ${error}`);
    }

    // Phase 3: Repair
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Phase 3/4: Repair');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    const hookType = (options.hookType || 'prompt') as HookType;

    await runRepair(
      serverURL,
      projectInfo.root,
      healthResult,
      projectKey,
      organization,
      options.skipHooks ? undefined : hookType
    );
  }

  // If no token and skipped health check, run repair anyway
  if (!token) {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Phase 3/4: Repair');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    const hookType = (options.hookType || 'prompt') as HookType;

    // Run repair with fake health result (everything needs fixing)
    await runRepair(
      serverURL,
      projectInfo.root,
      {
        tokenValid: false,
        serverAvailable: false,
        projectAccessible: false,
        organizationAccessible: false,
        qualityProfilesAccessible: false,
        dockerRunning: false,
        dockerImagePresent: false,
        mcpConfigured: false,
        hooksInstalled: false,
        errors: []
      },
      projectKey,
      organization,
      options.skipHooks ? undefined : hookType
    );

    // Get token after repair
    const repairedToken = await getToken(serverURL);
    if (!repairedToken) {
      console.error('\nError: Failed to obtain token');
      process.exit(1);
    }
    token = repairedToken;
  }

  // Phase 4: Final Verification
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Phase 4/4: Final Verification');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const finalHealth = await runHealthChecks(serverURL, token!, projectKey, projectInfo.root, organization);

  if (finalHealth.tokenValid) console.log('✓ Token valid');
  if (finalHealth.serverAvailable) console.log('✓ Server available');
  if (finalHealth.projectAccessible) console.log('✓ Project accessible');
  if (finalHealth.organizationAccessible) console.log('✓ Organization accessible');
  if (finalHealth.qualityProfilesAccessible) console.log('✓ Quality profiles accessible');
  if (finalHealth.dockerRunning) console.log('✓ Docker running');
  if (finalHealth.dockerImagePresent) console.log('✓ Docker image present');
  if (finalHealth.mcpConfigured) console.log('✓ MCP Server configured');
  if (finalHealth.hooksInstalled) console.log('✓ Hooks installed');

  // Note: We don't save .sonarqube/config.json anymore
  // All configuration is read from sonar-project.properties

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('✅ Setup complete!');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  if (finalHealth.errors.length > 0) {
    console.log('\n⚠️  Some issues remain:');
    for (const error of finalHealth.errors) {
      console.log(`   - ${error}`);
    }
  }
}
