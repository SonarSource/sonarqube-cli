import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from './read-json.ts';

const PLUGIN_MARKER_FILE = join('agent', 'sonarqube-agent-plugin.json');
const CLAUDE_OUTPUT_FILE = join('agent', 'claude-code.txt');
const PLUGIN_NAME = 'sonarqube';

interface PluginMarker {
  installed?: boolean;
  ref?: string;
  version?: string;
}

export interface TrialPlugin {
  /** `without`, `with <ref>`, or null for a trial from before the plugin option. */
  plugin: string | null;
  /** False when Claude Code started without the plugin that the trial asked for. */
  loaded: boolean;
}

function claudeInitPlugins(trialDir: string): string[] | null {
  const outputPath = join(trialDir, CLAUDE_OUTPUT_FILE);
  if (!existsSync(outputPath)) return null;
  for (const line of readFileSync(outputPath, 'utf8').split('\n')) {
    if (!line.startsWith('{')) continue;
    try {
      const event = JSON.parse(line) as {
        type?: string;
        subtype?: string;
        plugins?: { name?: string }[];
      };
      if (event.type === 'system' && event.subtype === 'init')
        return (event.plugins ?? []).map((plugin) => plugin.name ?? '');
    } catch {
      // Claude Code also writes plain text lines to this file.
    }
  }
  return null;
}

export function trialPlugin(trialDir: string, agent: string | null): TrialPlugin {
  const marker = readJson<PluginMarker>(join(trialDir, PLUGIN_MARKER_FILE));
  if (!marker) return { plugin: null, loaded: true };
  if (!marker.installed) return { plugin: 'without', loaded: true };
  // The ref is written before the install, so a failed install groups with its variant.
  const plugin = `with ${marker.ref || marker.version || ''}`.trim();
  const plugins = agent === 'claude-code' ? claudeInitPlugins(trialDir) : null;
  return { plugin, loaded: plugins === null || plugins.includes(PLUGIN_NAME) };
}
