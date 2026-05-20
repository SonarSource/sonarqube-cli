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

/**
 * Build-time script: generate GitHub release notes via the Anthropic API.
 *
 * Driven by the `generate-release-notes` job in .github/workflows/full-release.yml.
 * Can also be run locally for preview:
 *
 *   bun .github/scripts/generate-release-notes.ts --tag 0.12.0.1512 --dry-run
 *
 * In CI (RELEASED_VERSION + CLAUDE_CODE_API_KEY set):
 *
 *   bun .github/scripts/generate-release-notes.ts --out release-notes.md
 *
 * The script:
 *   1. Resolves the previous release tag with `git describe`.
 *   2. Collects commit subjects between the previous tag and the released one.
 *   3. Send two GitHub releases as style examples (hardcoded).
 *   4. Extracts JIRA keys from commit subjects and fetches their title/description
 *      from the Atlassian REST API when JIRA_USER / JIRA_TOKEN are set.
 *   5. Sends a prompt to the Anthropic Messages API and writes the Markdown result.
 *
 * No npm dependency is required — it speaks HTTPS directly.
 */

import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-5';
const MAX_TOKENS = 2048;
const ERROR_BODY_PREVIEW_CHARS = 500;
const JIRA_ERROR_BODY_PREVIEW_CHARS = 200;

// MAJOR.MINOR.PATCH — number of segments we keep for the user-facing short version.
const SHORT_VERSION_SEGMENT_COUNT = 3;

// MAJOR.MINOR.PATCH.BUILD — our release tag format. The fifth tag
// "testTom" and similar stray tags do not match this glob.
const RELEASE_TAG_GLOB = '[0-9]*.[0-9]*.[0-9]*.[0-9]*';

// Commit subjects that should not be considered changes from a user perspective.
const COMMIT_NOISE_PATTERNS: RegExp[] = [
  /^Prepare next development iteration\b/i,
  /^Bump (?:project )?version\b/i,
  /^Prepare release\b/i,
  /^\[Release]/i,
];

// JIRA enrichment. Issue keys look like `CLI-123`, `CODEFIX-456`, etc.
const JIRA_KEY_REGEX = /\b[A-Z][A-Z0-9_]+-\d+\b/g;
const JIRA_DEFAULT_BASE_URL = 'https://sonarsource.atlassian.net';
const JIRA_MAX_TICKETS = 40;
const JIRA_DESCRIPTION_MAX_CHARS = 800;

interface CliArgs {
  out?: string;
  tag?: string;
  dryRun: boolean;
}

interface CommitEntry {
  sha: string;
  subject: string;
}

interface JiraTicket {
  key: string;
  summary: string;
  description: string;
  issueType: string;
}

interface AnthropicMessagesResponse {
  content?: { type: string; text?: string }[];
  error?: { type?: string; message?: string };
}

function printUsageAndExit(code: number): never {
  console.error(
    [
      'Usage: bun .github/scripts/generate-release-notes.ts [options]',
      '',
      'Options:',
      '  --tag <tag>     Released version tag (overrides RELEASED_VERSION env).',
      '  --out <file>    Write the generated Markdown to this file.',
      '  --dry-run       Print the prompt without calling the Anthropic API.',
      '  -h, --help      Show this help message.',
      '',
      'Environment:',
      '  RELEASED_VERSION    Released version tag (e.g. 0.12.0.1512). Required without --tag.',
      '  CLAUDE_CODE_API_KEY Anthropic API key. Required unless --dry-run is set.',
      '  ANTHROPIC_MODEL     Override the model (default: ' + DEFAULT_MODEL + ').',
      '  GH_TOKEN            Forwarded to `gh release list`; usually set by GitHub Actions.',
      '  JIRA_USER           JIRA account email for fetching ticket context (optional).',
      '  JIRA_TOKEN          JIRA API token paired with JIRA_USER (optional).',
      '  JIRA_BASE_URL       Override the JIRA base URL (default: ' + JIRA_DEFAULT_BASE_URL + ').',
    ].join('\n'),
  );
  process.exit(code);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--out':
        args.out = argv[++i];
        if (!args.out) {
          console.error('--out requires a file path');
          printUsageAndExit(2);
        }
        break;
      case '--tag':
        args.tag = argv[++i];
        if (!args.tag) {
          console.error('--tag requires a value');
          printUsageAndExit(2);
        }
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '-h':
      case '--help':
        printUsageAndExit(0);
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        printUsageAndExit(2);
    }
  }
  return args;
}

function tryRunCmd(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function shortVersion(tag: string): string {
  const parts = tag.split('.');
  return parts.length < SHORT_VERSION_SEGMENT_COUNT
    ? tag
    : parts.slice(0, SHORT_VERSION_SEGMENT_COUNT).join('.');
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return 'unknown error';
  }
}

function assertTagExists(tag: string): void {
  const resolved = tryRunCmd(`git rev-parse --verify --quiet "${tag}^{commit}"`);
  if (!resolved) {
    throw new Error(
      `Tag "${tag}" is not in the local git repository. ` +
        'Make sure to check out with fetch-depth: 0 and fetch-tags: true.',
    );
  }
}

function resolvePreviousTag(tag: string): string | undefined {
  const prev = tryRunCmd(`git describe --tags --abbrev=0 --match '${RELEASE_TAG_GLOB}' "${tag}^"`);
  return prev || undefined;
}

function listCommits(previousTag: string | undefined, tag: string): CommitEntry[] {
  const range = previousTag ? `${previousTag}..${tag}` : tag;
  const output = tryRunCmd(`git log ${range} --no-merges --pretty=format:%h%x09%s`);
  if (!output) return [];
  return output
    .split('\n')
    .map<CommitEntry>((line) => {
      const tabIdx = line.indexOf('\t');
      if (tabIdx === -1) return { sha: '', subject: '' };
      return { sha: line.slice(0, tabIdx), subject: line.slice(tabIdx + 1) };
    })
    .filter((c) => c.sha && c.subject)
    .filter((c) => !COMMIT_NOISE_PATTERNS.some((rx) => rx.test(c.subject)));
}

const RELEASE_NOTES_FORMAT_EXAMPLE = `\
# SonarQube CLI v0.7.0

This release introduces the \`sonar integrate git\` command for installing secrets \
pre-commit/pre-push git hook. Also it adds MCP configuration for \`sonar integrate claude\` \
and fixes some bugs.

## Features

* Secrets pre-commit and pre-push hooks — automatically scans staged files for secrets before each commit or push
* Secrets binary auto-install — sonar integrate claude now installs the secrets scanner if not already present
* MCP Server configuration — sonar integrate claude configures the SonarQube MCP Server automatically
* Auth enforcement — feature commands now require active authentication

## Bug Fixes

* Fixed \`integrate claude\` incorrectly resolving organization from project context instead of auth
* Fixed Agentic Analysis hook installation for \`sonar integrate claude\` command

---

# SonarQube CLI v0.10.0

This release introduces several improvements and fixes some bugs.

## New Features & Enhancements

* **Platform Support:** Added support for Linux ARM64. Thanks to @mcfedr for the contribution!
* **Issue Filtering:** Added the ability to filter issues by statuses and by severities simultaneously.
* **Environment Variables in Auth:** \`sonar auth status\` now properly displays when a connection is being sourced from environment variables.
* **Agentic analysis:** Added a clear warning when no project is configured for SonarQube Agentic Analysis.

## Security & Authentication

* **Token Validation & Generation:** \`sonar auth status\` now actively checks if the current token is valid.
* Adjusted the token generation URL to support SonarQube Server 2026.2+.

## Bug Fixes

* **Hooks:** Fixed an issue to ensure pre-commit hooks are not duplicated.
* **SonarQube Cloud US Region Support:** Fixed an issue where Cloud API calls were hardcoded to the EU base URL, breaking SQC US environments, and properly added SQC US auth/mentions to the CLI help and README.

## Performance & Installation

* **Windows Installation:** Sped up \`install.ps1\` by silencing the progress bar.`;

function extractJiraKeys(commits: CommitEntry[]): string[] {
  const set = new Set<string>();
  for (const c of commits) {
    const matches = c.subject.matchAll(JIRA_KEY_REGEX);
    for (const m of matches) set.add(m[0]);
  }
  return [...set];
}

async function fetchJiraTicket(
  baseUrl: string,
  authHeader: string,
  key: string,
): Promise<JiraTicket | null> {
  // Atlassian REST API v2 returns description as plain text (wiki markup),
  // which is much easier to feed into a prompt than the v3 ADF JSON.
  const url = `${baseUrl}/rest/api/2/issue/${encodeURIComponent(key)}?fields=summary,description,issuetype`;
  const response = await fetch(url, {
    headers: {
      authorization: authHeader,
      accept: 'application/json',
    },
  });
  if (!response.ok) {
    let detail = '';
    try {
      const body = (await response.text()).trim();
      if (body) detail = ` — ${body.slice(0, JIRA_ERROR_BODY_PREVIEW_CHARS)}`;
    } catch {
      // ignore body read errors
    }
    console.error(`  ${key}: ${response.status} ${response.statusText}, skipped${detail}`);
    return null;
  }
  const data = (await response.json()) as {
    fields?: {
      summary?: string;
      description?: string | null;
      issuetype?: { name?: string };
    };
  };
  const summary = data.fields?.summary?.trim() ?? '';
  if (!summary) return null;
  let description = (data.fields?.description ?? '').toString().trim();
  if (description.length > JIRA_DESCRIPTION_MAX_CHARS) {
    description = description.slice(0, JIRA_DESCRIPTION_MAX_CHARS).trimEnd() + '…';
  }
  return {
    key,
    summary,
    description,
    issueType: data.fields?.issuetype?.name?.trim() ?? '',
  };
}

async function fetchJiraTickets(commits: CommitEntry[]): Promise<JiraTicket[]> {
  const baseUrl = process.env.JIRA_BASE_URL?.trim() || JIRA_DEFAULT_BASE_URL;
  const user = process.env.JIRA_USER?.trim() ?? '';
  const token = process.env.JIRA_TOKEN?.trim() ?? '';
  if (!user || !token) {
    console.error('JIRA_USER / JIRA_TOKEN not set; skipping JIRA enrichment.');
    return [];
  }
  const keys = extractJiraKeys(commits).slice(0, JIRA_MAX_TICKETS);
  if (keys.length === 0) {
    console.error('No JIRA keys found in commit subjects.');
    return [];
  }
  console.error(`Fetching ${keys.length} JIRA ticket(s) from ${baseUrl}…`);
  const credentials = `${user}:${token}`;
  const authHeader = `Basic ${Buffer.from(credentials).toString('base64')}`;
  const results = await Promise.all(
    keys.map((k) =>
      fetchJiraTicket(baseUrl, authHeader, k).catch((err: unknown) => {
        console.error(`  ${k}: error fetching, skipped: ${describeError(err)}`);
        return null;
      }),
    ),
  );
  return results.filter((t): t is JiraTicket => t !== null);
}

function buildPrompt(
  releasedVersion: string,
  commits: CommitEntry[],
  jiraTickets: JiraTicket[],
): string {
  const short = shortVersion(releasedVersion);
  const commitsText =
    commits.length === 0
      ? '(No commits found between the previous tag and this one.)'
      : commits.map((c) => `- ${c.subject} (${c.sha})`).join('\n');
  const jiraText =
    jiraTickets.length === 0
      ? '(No JIRA tickets resolved for this release.)'
      : jiraTickets
          .map((t) => {
            const issueTypePart = t.issueType ? ` (${t.issueType})` : '';
            const header = `### ${t.key}${issueTypePart}: ${t.summary}`;
            return t.description ? `${header}\n\n${t.description}` : header;
          })
          .join('\n\n');

  return [
    'You are writing the GitHub release notes for the SonarQube CLI (`sonar`).',
    `The released version is **${short}** (full tag: \`${releasedVersion}\`).`,
    '',
    'Below are examples of previous release notes. Match their tone, structure, and level of detail exactly:',
    '',
    RELEASE_NOTES_FORMAT_EXAMPLE,
    '',
    'Below is the list of commits included in this release (subject and short SHA).',
    'PR numbers like `(#123)` already inside subjects must be preserved verbatim.',
    'Ignore release bookkeeping commits ("Prepare next development iteration", version bumps, etc.).',
    '',
    commitsText,
    '',
    'Below are the JIRA tickets referenced by those commits, with their type, title, and description.',
    'Use them to write richer, user-facing entries when the commit subject alone is too terse,',
    'and to decide whether an item is a bug fix, a feature, or something else.',
    '',
    jiraText,
    '',
    'Now produce the release notes as Markdown, following these rules:',
    `- Start with a single H1 heading: \`# SonarQube CLI v${short}\`.`,
    '- Optionally include a one-paragraph summary right after the heading when there is a clear theme.',
    '- Use `## Features` for new functionality / enhancements (omit the section if empty).',
    '- Use `## Bug Fixes` for fixes (omit the section if empty).',
    '- Add other `## ...` sections (e.g. "Security", "Performance") only if they materially apply.',
    '- Keep entries short and user-facing. Group related commits / tickets when reasonable.',
    '- Do not include internal ticket prefixes (e.g. `CLI-123`), implementation details, or commit SHAs in the output.',
    '- Output Markdown only — no preamble, no closing remarks, no code fences around the document.',
  ].join('\n');
}

async function callAnthropic(apiKey: string, model: string, prompt: string): Promise<string> {
  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_API_VERSION,
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Anthropic API error ${response.status} ${response.statusText}: ${text.slice(0, ERROR_BODY_PREVIEW_CHARS)}`,
    );
  }

  let parsed: AnthropicMessagesResponse;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `Failed to parse Anthropic response as JSON: ${text.slice(0, ERROR_BODY_PREVIEW_CHARS)}`,
    );
  }

  if (parsed.error) {
    throw new Error(
      `Anthropic API error: ${parsed.error.type ?? 'unknown'}: ${parsed.error.message ?? text}`,
    );
  }

  const markdown = (parsed.content ?? [])
    .filter(
      (block): block is { type: 'text'; text: string } =>
        block.type === 'text' && typeof block.text === 'string',
    )
    .map((block) => block.text.trim())
    .join('\n\n')
    .trim();

  if (!markdown) {
    throw new Error('Anthropic response did not contain any text content');
  }

  return markdown;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const releasedVersion = args.tag ?? process.env.RELEASED_VERSION;
  if (!releasedVersion) {
    console.error('Missing released version: pass --tag <tag> or set RELEASED_VERSION.');
    process.exit(2);
  }

  // Sanity check: we need the tag locally to compute the change set.
  // `gh release list` does not need the tag locally and degrades gracefully if `gh` is missing.
  assertTagExists(releasedVersion);

  const previousTag = resolvePreviousTag(releasedVersion);
  if (previousTag) {
    console.error(`Using previous tag: ${previousTag}`);
  } else {
    console.error('No previous release tag found — using full history up to the released version.');
  }

  const commits = listCommits(previousTag, releasedVersion);
  console.error(`Collected ${commits.length} commit(s).`);

  const jiraTickets = await fetchJiraTickets(commits);
  console.error(`Enriched with ${jiraTickets.length} JIRA ticket(s).`);

  const prompt = buildPrompt(releasedVersion, commits, jiraTickets);

  if (args.dryRun) {
    if (args.out) {
      console.error('Note: --out is ignored in --dry-run mode (prompt is written to stdout).');
    }
    process.stdout.write(`${prompt}\n`);
    return;
  }

  const apiKey = process.env.CLAUDE_CODE_API_KEY;
  if (!apiKey) {
    console.error('CLAUDE_CODE_API_KEY is required (use --dry-run to skip the API call).');
    process.exit(2);
  }
  const model = process.env.ANTHROPIC_MODEL?.trim() ?? '';
  const effectiveModel = model.length > 0 ? model : DEFAULT_MODEL;

  console.error(`Calling Anthropic (${effectiveModel})…`);
  const markdown = await callAnthropic(apiKey, effectiveModel, prompt);

  process.stdout.write(`${markdown}\n`);
  if (args.out) {
    writeFileSync(args.out, `${markdown}\n`, 'utf-8');
    console.error(`Wrote ${args.out}.`);
  }
}

try {
  await main();
} catch (err) {
  console.error(`\nFailed: ${describeError(err)}`);
  process.exit(1);
}
