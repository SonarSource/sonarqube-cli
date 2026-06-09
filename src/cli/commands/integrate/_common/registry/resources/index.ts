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

export type {
  BaseResourceOptions,
  PathResolver,
  RemovableResource,
  RemoveablePatchResourceOptions,
  ResourceDeclaration,
  ResourceIdentity,
} from './common';
export { RemoveablePatchResource } from './common';
export {
  jsonPatch,
  type JsonPatchOptions,
  jsonPatchRemover,
  type JsonPatchRemoverOptions,
} from './json-patch';
export {
  TextSnippet,
  textSnippet,
  textSnippetRemover,
  type TextSnippetRemoverOptions,
  type TextSnippetResourceOptions,
} from './text-snippet';
export {
  TomlPatch,
  tomlPatch,
  type TomlPatchOptions,
  tomlPatchRemover,
  type TomlPatchRemoverOptions,
} from './toml-patch';
export {
  type PlatformSpecificContent,
  wholeFile,
  type WholeFileContent,
  wholeFileRemover,
  type WholeFileRemoverOptions,
  WholeFileResource,
  type WholeFileResourceOptions,
} from './whole-file';
export {
  YamlPatch,
  yamlPatch,
  type YamlPatchOptions,
  yamlPatchRemover,
  type YamlPatchRemoverOptions,
} from './yaml-patch';
