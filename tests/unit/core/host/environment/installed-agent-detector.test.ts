/*
 * SonarQube CLI
 * Copyright (C) SonarSource Sàrl
 * mailto:info AT sonarsource DOT com
 *
 * This program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 3 of the License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program; if not, write to the Free Software Foundation,
 * Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  agentDisplayName,
  detectInstalledAgents,
  isDetectedAgentId,
  SUPPORTED_AGENT_IDS,
} from '@/core/host/environment/installed-agent-detector.ts';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sonar-agent-detect-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('detectInstalledAgents', () => {
  it('detects nothing in an empty home directory', () => {
    expect(detectInstalledAgents(home)).toEqual([]);
  });

  it('detects an agent from its config directory', () => {
    mkdirSync(join(home, '.cursor'));
    mkdirSync(join(home, '.codex'));

    expect(detectInstalledAgents(home)).toEqual(['cursor', 'codex']);
  });

  it('detects Claude Code from either its directory or its config file', () => {
    writeFileSync(join(home, '.claude.json'), '{}');

    expect(detectInstalledAgents(home)).toEqual(['claude']);
  });

  it('does not infer Antigravity from the shared .agents directory', () => {
    // `.agents` is the cross-tool skills directory that Codex and Cursor also
    // read, so it identifies no single agent.
    mkdirSync(join(home, '.agents'));

    expect(detectInstalledAgents(home)).toEqual([]);
  });

  it('detects Antigravity from its own global config directory', () => {
    mkdirSync(join(home, '.gemini', 'config'), { recursive: true });

    expect(detectInstalledAgents(home)).toEqual(['antigravity']);
  });

  it('defaults to the real user home directory when none is given', () => {
    expect(Array.isArray(detectInstalledAgents())).toBe(true);
  });
});

describe('agentDisplayName', () => {
  it('has a non-empty label for every supported agent', () => {
    for (const agentId of SUPPORTED_AGENT_IDS) {
      expect(agentDisplayName(agentId)).toBeTruthy();
    }
  });

  it('returns the expected label for each agent', () => {
    expect(agentDisplayName('cursor')).toBe('Cursor');
    expect(agentDisplayName('claude')).toBe('Claude Code');
    expect(agentDisplayName('codex')).toBe('Codex');
    expect(agentDisplayName('copilot')).toBe('Copilot');
    expect(agentDisplayName('antigravity')).toBe('Antigravity');
  });
});

describe('isDetectedAgentId', () => {
  it('returns true only for an agent actually installed in the given home directory', () => {
    mkdirSync(join(home, '.cursor'));

    expect(isDetectedAgentId('cursor', home)).toBe(true);
    expect(isDetectedAgentId('claude', home)).toBe(false);
  });

  it('returns false for a supported agent id that is not installed anywhere', () => {
    expect(isDetectedAgentId('cursor', home)).toBe(false);
  });

  it('returns false for a value that is not a supported agent id at all', () => {
    mkdirSync(join(home, '.cursor'));

    expect(isDetectedAgentId('not-an-agent', home)).toBe(false);
  });

  it('defaults to the real user home directory when none is given', () => {
    expect(typeof isDetectedAgentId('cursor')).toBe('boolean');
  });
});
