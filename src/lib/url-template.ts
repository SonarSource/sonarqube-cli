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

/**
 * Replace `{key}` placeholders in a URL string with values from a context map.
 * Values are URI-encoded. Throws if a placeholder has no matching context key.
 */
export function resolveUrlTemplate(template: string, context: Record<string, string>): string {
  return template.replaceAll(/\{(\w+)\}/g, (_match, key: string) => {
    if (!(key in context)) {
      const available = Object.keys(context).join(', ');
      throw new Error(
        `Unknown template variable {${key}}. Available variables: ${available || '(none)'}`,
      );
    }
    return encodeURIComponent(context[key]);
  });
}
