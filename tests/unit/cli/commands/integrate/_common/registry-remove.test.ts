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

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type {
  FeatureDeclaration,
  IntegrationContext,
} from '../../../../../../src/cli/commands/integrate/_common/registry';
import { getDefaultState } from '../../../../../../src/lib/state';

const { IntegrationInstaller, jsonPatch, textSnippet, tomlPatch, wholeFile, yamlPatch } =
  await import('../../../../../../src/cli/commands/integrate/_common/registry');

describe('declarative integration framework - remove and undo', () => {
  const installer = new IntegrationInstaller();
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'sonar-cli-framework-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('treats empty JSON files as the default document', async () => {
    const state = getDefaultState('test');
    const context = makeContext(state, tempDir);
    const jsonPath = join(tempDir, 'settings.json');
    await writeFile(jsonPath, '');
    const jsonResource = jsonPatch({
      id: 'json-empty',
      targetPath: jsonPath,
      defaultValue: { fallback: true },
      patch: (document) => ({ ...(document as Record<string, unknown>), enabled: true }),
      removePatch: (document) => document,
    });

    await jsonResource.apply(context);

    const written = JSON.parse(await readFile(jsonPath, 'utf-8')) as Record<string, unknown>;
    expect(written).toEqual({ fallback: true, enabled: true });
  });

  it('fails when JSON files contain invalid content', async () => {
    const state = getDefaultState('test');
    const context = makeContext(state, tempDir);
    const jsonPath = join(tempDir, 'settings.json');
    await writeFile(jsonPath, '{ invalid json');
    const jsonResource = jsonPatch({
      id: 'json-invalid',
      targetPath: jsonPath,
      defaultValue: { fallback: true },
      patch: (document) => ({ ...(document as Record<string, unknown>), enabled: true }),
      removePatch: (document) => document,
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun expect().rejects is awaitable at runtime; typings omit Thenable
    await expect(jsonResource.apply(context)).rejects.toThrow(
      `${jsonPath} contains invalid JSON. Please fix or delete it and re-run.`,
    );
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun expect().rejects is awaitable at runtime; typings omit Thenable
    await expect(jsonResource.isApplied(context)).rejects.toThrow(
      `${jsonPath} contains invalid JSON. Please fix or delete it and re-run.`,
    );
  });

  it('fails when TOML files contain invalid content', async () => {
    const state = getDefaultState('test');
    const context = makeContext(state, tempDir);
    const tomlPath = join(tempDir, 'config.toml');
    await writeFile(tomlPath, '= not valid toml =');
    const tomlResource = tomlPatch({
      id: 'toml-invalid',
      targetPath: tomlPath,
      defaultValue: {},
      patch: (document) => document,
      removePatch: (document) => document,
    });

    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun expect().rejects is awaitable at runtime; typings omit Thenable
    await expect(tomlResource.apply(context)).rejects.toThrow(
      `${tomlPath} contains invalid TOML. Please fix or delete it and re-run.`,
    );
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Bun expect().rejects is awaitable at runtime; typings omit Thenable
    await expect(tomlResource.isApplied(context)).rejects.toThrow(
      `${tomlPath} contains invalid TOML. Please fix or delete it and re-run.`,
    );
  });

  it('uses defaults when YAML files contain invalid content', async () => {
    const state = getDefaultState('test');
    const context = makeContext(state, tempDir);
    const yamlPath = join(tempDir, 'settings.yml');
    await writeFile(yamlPath, 'invalid: [yaml');
    const yamlResource = yamlPatch({
      id: 'yaml-invalid',
      targetPath: yamlPath,
      patch: (document) => ({ ...(document as Record<string, unknown>), enabled: true }),
      removePatch: (document) => document,
    });

    await yamlResource.apply(context);

    expect(await readFile(yamlPath, 'utf-8')).toBe('enabled: true\n');
    expect(await yamlResource.isApplied(context)).toBe(true);
  });

  describe('remove', () => {
    it('whole-file: deletes the file', async () => {
      const state = getDefaultState('test');
      const context = makeContext(state, tempDir);
      const filePath = join(tempDir, 'script.sh');
      const resource = wholeFile({ id: 'r', targetPath: filePath, content: '#!/bin/sh\n' });
      await resource.apply(context);

      await resource.remove(context);

      expect(existsSync(filePath)).toBe(false);
    });

    it('whole-file: is a no-op when the file does not exist', async () => {
      const state = getDefaultState('test');
      const context = makeContext(state, tempDir);
      const resource = wholeFile({
        id: 'r',
        targetPath: join(tempDir, 'missing.sh'),
        content: '#!/bin/sh\n',
      });

      expect(await resource.remove(context)).toBeUndefined();
    });

    it('json-patch: removes keys added by removePatch', async () => {
      const state = getDefaultState('test');
      const context = makeContext(state, tempDir);
      const jsonPath = join(tempDir, 'settings.json');
      const resource = jsonPatch({
        id: 'r',
        targetPath: jsonPath,
        patch: (doc) => ({ ...(doc as object), sonar: true }),
        removePatch: (doc) => {
          const { sonar: _, ...rest } = doc as Record<string, unknown>;
          return rest;
        },
      });
      await writeFile(jsonPath, JSON.stringify({ existing: 1, sonar: true }, null, 2) + '\n');

      await resource.remove(context);

      expect(JSON.parse(await readFile(jsonPath, 'utf-8'))).toEqual({ existing: 1 });
    });

    it('json-patch: identity removePatch leaves file unchanged', async () => {
      const state = getDefaultState('test');
      const context = makeContext(state, tempDir);
      const jsonPath = join(tempDir, 'settings.json');
      await writeFile(jsonPath, '{"sonar":true}');
      const resource = jsonPatch({
        id: 'r',
        targetPath: jsonPath,
        patch: (doc) => ({ ...(doc as object), sonar: true }),
        removePatch: (doc) => doc,
      });

      await resource.remove(context);

      expect(JSON.parse(await readFile(jsonPath, 'utf-8'))).toEqual({ sonar: true });
    });

    it('json-patch: is a no-op when the file does not exist', async () => {
      const state = getDefaultState('test');
      const context = makeContext(state, tempDir);
      const resource = jsonPatch({
        id: 'r',
        targetPath: join(tempDir, 'missing.json'),
        patch: (doc) => doc,
        removePatch: (doc) => doc,
      });

      expect(await resource.remove(context)).toBeUndefined();
    });

    it('json-patch: deletes the file when removal leaves only the default baseline', async () => {
      const state = getDefaultState('test');
      const context = makeContext(state, tempDir);
      const jsonPath = join(tempDir, 'hooks.json');
      const resource = jsonPatch({
        id: 'r',
        targetPath: jsonPath,
        defaultValue: { version: 1, hooks: {} },
        patch: (doc) => ({ ...(doc as object), hooks: { preToolUse: [{ sonar: true }] } }),
        removePatch: () => ({ version: 1, hooks: {} }),
      });
      await writeFile(
        jsonPath,
        JSON.stringify({ version: 1, hooks: { preToolUse: [{ sonar: true }] } }, null, 2) + '\n',
      );

      await resource.remove(context);

      expect(existsSync(jsonPath)).toBe(false);
    });

    it('json-patch: deletes the file when removal prunes to the empty default', async () => {
      const state = getDefaultState('test');
      const context = makeContext(state, tempDir);
      const jsonPath = join(tempDir, '.mcp.json');
      const resource = jsonPatch({
        id: 'r',
        targetPath: jsonPath,
        defaultValue: {},
        patch: (doc) => ({ ...doc, mcpServers: { sonarqube: {} } }),
        removePatch: () => ({ mcpServers: {} }),
      });
      await writeFile(jsonPath, JSON.stringify({ mcpServers: { sonarqube: {} } }, null, 2) + '\n');

      await resource.remove(context);

      expect(existsSync(jsonPath)).toBe(false);
    });

    it('json-patch: keeps the file when other content survives pruning', async () => {
      const state = getDefaultState('test');
      const context = makeContext(state, tempDir);
      const jsonPath = join(tempDir, '.mcp.json');
      const resource = jsonPatch({
        id: 'r',
        targetPath: jsonPath,
        defaultValue: {},
        patch: (doc) => doc,
        removePatch: () => ({ mcpServers: { other: { command: 'x' } } }),
      });
      await writeFile(
        jsonPath,
        JSON.stringify({ mcpServers: { sonarqube: {}, other: { command: 'x' } } }, null, 2) + '\n',
      );

      await resource.remove(context);

      expect(existsSync(jsonPath)).toBe(true);
      expect(JSON.parse(await readFile(jsonPath, 'utf-8'))).toEqual({
        mcpServers: { other: { command: 'x' } },
      });
    });

    it('json-patch: keeps the file when only null or empty-valued user keys remain', async () => {
      const state = getDefaultState('test');
      const context = makeContext(state, tempDir);
      const jsonPath = join(tempDir, '.mcp.json');
      const resource = jsonPatch({
        id: 'r',
        targetPath: jsonPath,
        defaultValue: {},
        patch: (doc) => doc,
        removePatch: () => ({ mcpServers: {}, userKey: null }),
      });
      await writeFile(
        jsonPath,
        JSON.stringify({ mcpServers: { sonarqube: {} }, userKey: null }, null, 2) + '\n',
      );

      await resource.remove(context);

      expect(existsSync(jsonPath)).toBe(true);
      expect(JSON.parse(await readFile(jsonPath, 'utf-8'))).toEqual({
        mcpServers: {},
        userKey: null,
      });
    });

    it('toml-patch: deletes the file when removal leaves only the default baseline', async () => {
      const state = getDefaultState('test');
      const context = makeContext(state, tempDir);
      const tomlPath = join(tempDir, 'config.toml');
      const resource = tomlPatch({
        id: 'r',
        targetPath: tomlPath,
        defaultValue: {},
        patch: (doc) => doc,
        removePatch: () => ({ mcp_servers: {} }),
      });
      await writeFile(tomlPath, '[mcp_servers.sonarqube]\ncommand = "sonar"\n');

      await resource.remove(context);

      expect(existsSync(tomlPath)).toBe(false);
    });

    it('toml-patch: keeps the file when other content survives pruning', async () => {
      const state = getDefaultState('test');
      const context = makeContext(state, tempDir);
      const tomlPath = join(tempDir, 'config.toml');
      const resource = tomlPatch({
        id: 'r',
        targetPath: tomlPath,
        defaultValue: {},
        patch: (doc) => doc,
        removePatch: () => ({ mcp_servers: { other: { command: 'x' } } }),
      });
      await writeFile(
        tomlPath,
        '[mcp_servers.sonarqube]\ncommand = "sonar"\n\n[mcp_servers.other]\ncommand = "x"\n',
      );

      await resource.remove(context);

      expect(existsSync(tomlPath)).toBe(true);
      const content = await readFile(tomlPath, 'utf-8');
      expect(content).toContain('other');
      expect(content).not.toContain('sonarqube');
    });

    it('yaml-patch: deletes the file when removal prunes it empty', async () => {
      const state = getDefaultState('test');
      const context = makeContext(state, tempDir);
      const yamlPath = join(tempDir, 'config.yml');
      const resource = yamlPatch({
        id: 'r',
        targetPath: yamlPath,
        patch: (doc) => doc,
        removePatch: () => ({ sonar: {} }),
      });
      await writeFile(yamlPath, 'sonar:\n  enabled: true\n');

      await resource.remove(context);

      expect(existsSync(yamlPath)).toBe(false);
    });

    it('yaml-patch: deletes the file when removal prunes to the declared default baseline', async () => {
      const state = getDefaultState('test');
      const context = makeContext(state, tempDir);
      const yamlPath = join(tempDir, 'config.yml');
      const resource = yamlPatch({
        id: 'r',
        targetPath: yamlPath,
        defaultValue: { version: 1 },
        patch: (doc) => doc,
        removePatch: () => ({ version: 1, sonar: {} }),
      });
      await writeFile(yamlPath, 'version: 1\nsonar:\n  enabled: true\n');

      await resource.remove(context);

      expect(existsSync(yamlPath)).toBe(false);
    });

    it('yaml-patch: keeps the file when other content survives pruning', async () => {
      const state = getDefaultState('test');
      const context = makeContext(state, tempDir);
      const yamlPath = join(tempDir, 'config.yml');
      const resource = yamlPatch({
        id: 'r',
        targetPath: yamlPath,
        patch: (doc) => doc,
        removePatch: () => ({ other: { enabled: true } }),
      });
      await writeFile(yamlPath, 'sonar:\n  enabled: true\nother:\n  enabled: true\n');

      await resource.remove(context);

      expect(existsSync(yamlPath)).toBe(true);
      const content = await readFile(yamlPath, 'utf-8');
      expect(content).toContain('other');
      expect(content).not.toContain('sonar');
    });

    it('yaml-patch: removes entries added by removePatch', async () => {
      const state = getDefaultState('test');
      const context = makeContext(state, tempDir);
      const yamlPath = join(tempDir, 'config.yml');
      const resource = yamlPatch({
        id: 'r',
        targetPath: yamlPath,
        patch: (doc) => ({ ...(doc as object), sonar: true }),
        removePatch: (doc) => {
          const { sonar: _, ...rest } = doc as Record<string, unknown>;
          return rest;
        },
      });
      await writeFile(yamlPath, 'existing: 1\nsonar: true\n');

      await resource.remove(context);

      expect(await readFile(yamlPath, 'utf-8')).toBe('existing: 1\n');
    });

    it('yaml-patch: identity removePatch leaves file unchanged', async () => {
      const state = getDefaultState('test');
      const context = makeContext(state, tempDir);
      const yamlPath = join(tempDir, 'config.yml');
      const original = 'sonar: true\n';
      await writeFile(yamlPath, original);
      const resource = yamlPatch({
        id: 'r',
        targetPath: yamlPath,
        patch: (doc) => doc,
        removePatch: (doc) => doc,
      });

      await resource.remove(context);

      expect(await readFile(yamlPath, 'utf-8')).toBe(original);
    });

    it('toml-patch: removes keys added by removePatch', async () => {
      const state = getDefaultState('test');
      const context = makeContext(state, tempDir);
      const tomlPath = join(tempDir, 'config.toml');
      const resource = tomlPatch({
        id: 'r',
        targetPath: tomlPath,
        patch: (doc) => ({ ...doc, sonar: true }),
        removePatch: (doc) => {
          const { sonar: _, ...rest } = doc;
          return rest;
        },
      });
      await writeFile(tomlPath, 'existing = 1\nsonar = true\n');

      await resource.remove(context);

      expect(await readFile(tomlPath, 'utf-8')).toBe('existing = 1\n');
    });

    it('toml-patch: identity removePatch leaves file unchanged', async () => {
      const state = getDefaultState('test');
      const context = makeContext(state, tempDir);
      const tomlPath = join(tempDir, 'config.toml');
      const original = 'sonar = true\n';
      await writeFile(tomlPath, original);
      const resource = tomlPatch({
        id: 'r',
        targetPath: tomlPath,
        patch: (doc) => doc,
        removePatch: (doc) => doc,
      });

      await resource.remove(context);

      expect(await readFile(tomlPath, 'utf-8')).toBe(original);
    });

    it('text-snippet: deletes the file when the managed block was its only content', async () => {
      const state = getDefaultState('test');
      const context = makeContext(state, tempDir);
      const filePath = join(tempDir, 'pre-commit-config.yaml');
      const resource = textSnippet({
        id: 'r',
        targetPath: filePath,
        content: 'repos: []',
        startMarker: '# sonar:begin',
      });
      await resource.apply(context);

      await resource.remove(context);

      expect(existsSync(filePath)).toBe(false);
    });

    it('text-snippet: removes block from a file with surrounding content', async () => {
      const state = getDefaultState('test');
      const context = makeContext(state, tempDir);
      const filePath = join(tempDir, 'pre-commit-config.yaml');
      const resource = textSnippet({
        id: 'r',
        targetPath: filePath,
        content: 'repos: []',
        startMarker: '# sonar:begin',
      });
      await writeFile(
        filePath,
        'before: 1\n\n# sonar:begin\nrepos: []\n# sonar:end r\n\nafter: 2\n',
      );

      await resource.remove(context);

      expect(existsSync(filePath)).toBe(true);
      expect(await readFile(filePath, 'utf-8')).toBe('before: 1\n\nafter: 2\n');
    });

    it('text-snippet: keeps one blank line when block has a blank line on each side', async () => {
      const state = getDefaultState('test');
      const context = makeContext(state, tempDir);
      const filePath = join(tempDir, 'hook');
      const resource = textSnippet({
        id: 's',
        targetPath: filePath,
        content: 'body',
        startMarker: '# sonar:begin s',
      });
      await writeFile(
        filePath,
        'echo before\n\n# sonar:begin s\nbody\n# sonar:end s\n\necho after\n',
      );

      await resource.remove(context);

      expect(await readFile(filePath, 'utf-8')).toBe('echo before\n\necho after\n');
    });

    it('text-snippet: keeps adjacent lines separated when block sits between single newlines', async () => {
      const state = getDefaultState('test');
      const context = makeContext(state, tempDir);
      const filePath = join(tempDir, 'hook');
      const resource = textSnippet({
        id: 's',
        targetPath: filePath,
        content: 'body',
        startMarker: '# sonar:begin s',
      });
      await writeFile(filePath, 'echo before\n# sonar:begin s\nbody\n# sonar:end s\necho after\n');

      await resource.remove(context);

      expect(await readFile(filePath, 'utf-8')).toBe('echo before\necho after\n');
    });

    it('text-snippet: is a no-op when the file does not exist', async () => {
      const state = getDefaultState('test');
      const context = makeContext(state, tempDir);
      const resource = textSnippet({
        id: 'r',
        targetPath: join(tempDir, 'missing.yaml'),
        content: 'repos: []',
        startMarker: '# sonar:begin',
      });

      expect(await resource.remove(context)).toBeUndefined();
    });

    it('text-snippet: is a no-op when markers are absent', async () => {
      const state = getDefaultState('test');
      const context = makeContext(state, tempDir);
      const filePath = join(tempDir, 'existing.yaml');
      const original = 'repos: []\n';
      await writeFile(filePath, original);
      const resource = textSnippet({
        id: 'r',
        targetPath: filePath,
        content: 'something',
        startMarker: '# sonar:begin',
      });

      await resource.remove(context);

      expect(await readFile(filePath, 'utf-8')).toBe(original);
    });
  });

  describe('removeFeature', () => {
    it('removes resources and undoes operations, skipping those without remove/undo', async () => {
      const state = getDefaultState('test');
      const context = makeContext(state, tempDir);
      const filePath = join(tempDir, 'script.sh');
      const jsonPath = join(tempDir, 'settings.json');
      const removedResources: string[] = [];
      const skippedResources: string[] = [];
      const undoneOperations: string[] = [];
      await writeFile(filePath, '#!/bin/sh\n');
      await writeFile(jsonPath, JSON.stringify({ sonar: true }, null, 2) + '\n');

      const feature: FeatureDeclaration = {
        id: 'feature',
        displayName: 'Feature',
        resources: [
          wholeFile({ id: 'whole', targetPath: filePath, content: '#!/bin/sh\n' }),
          {
            id: 'no-op-remove',
            resourceType: 'custom',
            apply: () => ({ id: 'no-op-remove', resourceType: 'custom' }),
            isApplied: () => false,
            remove: async () => {},
          },
        ],
        operations: [
          { id: 'op-no-undo', apply: () => undefined },
          { id: 'op-with-undo', apply: () => undefined, undo: () => undefined },
        ],
      };

      await installer.removeFeature(context, feature, {
        onResourceRemoved: (r) => removedResources.push(r.id),
        onResourceSkipped: (r) => skippedResources.push(r.id),
        onOperationUndone: (o) => undoneOperations.push(o.id),
      });

      expect(existsSync(filePath)).toBe(false);
      expect(removedResources).toEqual(['whole', 'no-op-remove']);
      expect(skippedResources).toEqual([]);
      expect(undoneOperations).toEqual(['op-with-undo']);
    });

    it('undoes operations in reverse order', async () => {
      const state = getDefaultState('test');
      const context = makeContext(state, tempDir);
      const order: string[] = [];
      const feature: FeatureDeclaration = {
        id: 'feature',
        displayName: 'Feature',
        operations: [
          {
            id: 'first',
            apply: () => undefined,
            undo: () => {
              order.push('first');
            },
          },
          {
            id: 'second',
            apply: () => undefined,
            undo: () => {
              order.push('second');
            },
          },
          {
            id: 'third',
            apply: () => undefined,
            undo: () => {
              order.push('third');
            },
          },
        ],
      };

      await installer.removeFeature(context, feature);

      expect(order).toEqual(['third', 'second', 'first']);
    });
  });
});

function makeContext(
  state: ReturnType<typeof getDefaultState>,
  targetRoot: string,
  attrs?: IntegrationContext['attrs'],
  force?: boolean,
): IntegrationContext {
  return {
    state,
    targetRoot,
    scope: 'project',
    executionMode: 'install',
    force,
    attrs,
    resolvedDependencies: new Map(),
  };
}
