// Analyze command - analyze a file using SonarCloud A3S API

import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { SonarQubeClient } from '../sonarqube/client.js';
import { loadAnalyzeConfig, saveAnalyzeConfig, getConfigLocation } from '../lib/analyze-config.js';
import { encodeToToon } from '../formatter/toon.js';
import { getToken, getAllCredentials } from '../lib/keychain.js';

// Hardcoded SonarCloud A3S API base URL
const SONARCLOUD_API_URL = 'https://api.sonarcloud.io';
const SONARCLOUD_URL = 'https://sonarcloud.io';

export interface AnalyzeOptions {
  file: string;
  token?: string;
  organizationKey?: string;
  projectKey?: string;
  branch?: string;
  saveConfig?: boolean;
}

interface AnalyzeRequest {
  organizationKey: string;
  projectKey: string;
  filePath: string;
  fileContent: string;
  branch?: string;
}

interface AnalyzeResponse {
  issues?: Array<{
    ruleKey: string;
    message: string;
    severity: string;
    line?: number;
    column?: number;
  }>;
  status?: string;
  [key: string]: unknown;
}

/**
 * Analyze file command handler
 */
export async function analyzeCommand(options: AnalyzeOptions): Promise<void> {
  // Validate required options
  if (!options.file) {
    console.error('Error: --file is required');
    process.exit(1);
  }

  // Get values from options or config
  let organizationKey = options.organizationKey;
  let projectKey = options.projectKey;
  let token = options.token;

  // Try to get credentials from OS keychain if not provided via options or config
  if (!token || !organizationKey) {
    try {
      // First, try to get token for the specific organization if provided
      if (organizationKey && !token) {
        const keychainToken = await getToken(SONARCLOUD_URL, organizationKey);
        if (keychainToken) {
          token = keychainToken;
        }
      }
      
      // If still no token/org, try to find any stored SonarCloud credentials
      if (!token || !organizationKey) {
        const credentials = await getAllCredentials();
        const sonarCloudCreds = credentials.filter(cred => 
          cred.account.startsWith('sonarcloud.io:')
        );
        
        if (sonarCloudCreds.length > 0) {
          // Use the first available SonarCloud credential
          const cred = sonarCloudCreds[0];
          const [, org] = cred.account.split(':');
          
          if (!organizationKey) {
            organizationKey = org;
          }
          
          if (!token) {
            token = cred.password;
          }
          
          if (sonarCloudCreds.length > 1) {
            console.log(`ℹ Multiple organizations found (${sonarCloudCreds.length}). Using: ${org}`);
            console.log('  To use a different organization, specify --organization-key');
          }
        }
      }
    } catch (error) {
      // Silently fail keychain access - will validate required values below
    }
  }


  // Validate required values
  if (!organizationKey) {
    console.error('❌ Error: --organization-key is required');
    console.error('  Provide via: --organization-key flag, or login with: sonar-cli auth login');
    console.error(`  Config location: ${getConfigLocation()}`);
    process.exit(1);
  }

  if (!projectKey) {
    console.error('❌ Error: --project-key is required');
    console.error('  Provide via: --project-key flag');
    console.error(`  Config location: ${getConfigLocation()}`);
    process.exit(1);
  }

  if (!token) {
    console.error('❌ Error: --token is required');
    console.error('  Provide via: --token flag, or login with: sonar-cli auth login');
    console.error(`  Config location: ${getConfigLocation()}`);
    process.exit(1);
  }

  // Save config if requested
  if (options.saveConfig) {
    saveAnalyzeConfig({
      organizationKey,
      projectKey,
      token
    });
    console.log(`Configuration saved to: ${getConfigLocation()}`);
  }

  // Resolve absolute path for file operations
  const absPath = resolve(options.file);

  // Check file exists
  if (!existsSync(absPath)) {
    console.error(`Error: File not found: ${absPath}`);
    process.exit(1);
  }

  // Read file content
  let fileContent: string;
  try {
    fileContent = readFileSync(absPath, 'utf-8');
  } catch (error) {
    console.error(`Error reading file: ${(error as Error).message}`);
    process.exit(1);
  }

  // Create client with hardcoded SonarCloud URL
  const client = new SonarQubeClient(SONARCLOUD_API_URL, token);

  // Build request body with relative path
  const requestBody: AnalyzeRequest = {
    organizationKey,
    projectKey,
    filePath: options.file, // Use original relative path from input
    fileContent: fileContent
  };

  // Add branch if provided
  if (options.branch) {
    requestBody.branch = options.branch;
  }

  try {
    console.log('Analyzing file...');
    
    // Make API request
    const result = await client.post<AnalyzeResponse>(
      '/a3s-analysis/analyses',
      requestBody
    );
    
    // Format and display results in TOON format
    console.log(encodeToToon(result));

  } catch (error) {
    console.error('\n❌ Analysis failed!');
    console.error(`   Error: ${(error as Error).message}`);
    console.error('');
    console.error('💡 Troubleshooting:');
    console.error(`   - Verify organization "${organizationKey}" has access to project "${projectKey}"`);
    console.error('   - Check that your token has the correct permissions');
    console.error(`   - Try running: sonar-cli auth logout --org ${organizationKey}`);
    console.error(`   - Then: sonar-cli auth login --org ${organizationKey}`);
    console.error('');
    process.exit(1);
  }
}
