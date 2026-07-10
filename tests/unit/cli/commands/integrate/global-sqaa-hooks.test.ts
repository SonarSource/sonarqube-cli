import { describe, expect, test } from 'bun:test';

import {
  formatSqaaHookCliArgsUnix,
  formatSqaaPostToolHookCommandUnix,
} from '../../../../../src/cli/commands/integrate/_common/hooks';
import { buildSqaaSectionBody } from '../../../../../src/cli/commands/integrate/_common/instructions-templates';

describe('global SQAA hook commands', () => {
  test('omits --project when project key is absent', () => {
    expect(formatSqaaHookCliArgsUnix('claude-post-tool-use')).toBe('hook claude-post-tool-use');
    expect(formatSqaaPostToolHookCommandUnix('claude-post-tool-use')).toBe(
      'sonar hook claude-post-tool-use',
    );
  });

  test('includes --project when project key is provided', () => {
    expect(formatSqaaHookCliArgsUnix('claude-post-tool-use', 'my-org:demo')).toBe(
      "hook claude-post-tool-use --project 'my-org:demo'",
    );
  });
});

describe('buildSqaaSectionBody', () => {
  test('renders project-agnostic commands when key is omitted', () => {
    const body = buildSqaaSectionBody();
    expect(body).toContain('sonar analyze agentic --depth DEEP');
    expect(body).not.toContain('--project');
  });

  test('renders baked project key when provided', () => {
    const body = buildSqaaSectionBody('my-org:demo');
    expect(body).toContain('sonar analyze agentic --project my-org:demo --depth DEEP');
  });
});
