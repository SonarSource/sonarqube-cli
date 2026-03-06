/*
 * SonarQube CLI
 * Copyright (C) 2026 SonarSource Sàrl
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

import { describe, expect, it } from 'bun:test';
import { resolveUrlTemplate } from '../../src/lib/url-template.js';

describe('resolveUrlTemplate', () => {
  it('replaces a single variable', () => {
    const result = resolveUrlTemplate('/api/issues/search?organization={organization}', {
      organization: 'my-org',
    });
    expect(result).toBe('/api/issues/search?organization=my-org');
  });

  it('replaces multiple variables', () => {
    const result = resolveUrlTemplate(
      '/api/issues/search?organization={organization}&project={project}',
      { organization: 'my-org', project: 'my-project' },
    );
    expect(result).toBe('/api/issues/search?organization=my-org&project=my-project');
  });

  it('URL-encodes special characters', () => {
    const result = resolveUrlTemplate('/api/search?q={query}', {
      query: 'hello world&foo=bar',
    });
    expect(result).toBe('/api/search?q=hello%20world%26foo%3Dbar');
  });

  it('passes through strings with no templates', () => {
    const result = resolveUrlTemplate('/api/system/status', {});
    expect(result).toBe('/api/system/status');
  });

  it('works with empty context when there are no templates', () => {
    const result = resolveUrlTemplate('/api/system/status?ps=100', {});
    expect(result).toBe('/api/system/status?ps=100');
  });

  it('throws on unknown template variable', () => {
    expect(() => resolveUrlTemplate('/api/issues/search?project={project}', {})).toThrow(
      'Unknown template variable {project}',
    );
  });

  it('lists available variables in error message', () => {
    expect(() =>
      resolveUrlTemplate('/api/issues/search?project={project}', {
        organization: 'my-org',
      }),
    ).toThrow('Available variables: organization');
  });

  it('shows (none) when no variables are available', () => {
    expect(() => resolveUrlTemplate('/api/{unknown}', {})).toThrow('Available variables: (none)');
  });

  it('replaces the same variable used multiple times', () => {
    const result = resolveUrlTemplate('/api/{project}/issues?project={project}', {
      project: 'my-proj',
    });
    expect(result).toBe('/api/my-proj/issues?project=my-proj');
  });
});
