import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TaskDescription {
  id: string;
  question: string;
  tests: string;
  start: string[];
  success: string;
  request: string;
  checks: { key: string; text: string }[];
}

const SECTIONS = ['What it tests', 'Starting point', 'What counts as success', 'Checks'];
const CHECK_LINE = /^- `([a-z0-9_]+)`: (.+)$/;

function parseSections(id: string, text: string): { question: string; bodies: string[] } {
  const lines = text.split(/\r?\n/);
  const question = lines[0].startsWith('# ') ? lines[0].slice(2).trim() : '';
  const titles: string[] = [];
  const bodies: string[] = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith('## ')) {
      titles.push(line.slice(3).trim());
      bodies.push('');
    } else if (bodies.length > 0) {
      bodies[bodies.length - 1] += `${line}\n`;
    }
  }
  if (!question || titles.join('|') !== SECTIONS.join('|'))
    throw new Error(
      `tasks/${id}/description.md must start with "# <question>" and hold the sections ${SECTIONS.map((title) => `"${title}"`).join(', ')}, in this order`,
    );
  const trimmed = bodies.map((body) => body.trim());
  const empty = SECTIONS.find((_, index) => trimmed[index] === '');
  if (empty) throw new Error(`Section "${empty}" of tasks/${id}/description.md is empty`);
  return { question, bodies: trimmed };
}

function parseChecks(id: string, body: string): TaskDescription['checks'] {
  return body.split('\n').map((line) => {
    const match = CHECK_LINE.exec(line);
    if (!match)
      throw new Error(
        `Malformed check in tasks/${id}/description.md: "${line}" (expected "- \`key\`: sentence")`,
      );
    return { key: match[1], text: match[2] };
  });
}

function readTaskDescription(tasksDir: string, id: string): TaskDescription {
  const { question, bodies } = parseSections(
    id,
    readFileSync(join(tasksDir, id, 'description.md'), 'utf8'),
  );
  const request = readFileSync(join(tasksDir, id, 'instruction.md'), 'utf8').trim();
  if (request === '') throw new Error(`tasks/${id}/instruction.md is empty`);
  return {
    id,
    question,
    tests: bodies[0],
    start: bodies[1].split(/\n\s*\n/).map((paragraph) => paragraph.trim()),
    success: bodies[2],
    request,
    checks: parseChecks(id, bodies[3]),
  };
}

export function readTaskDescriptions(tasksDir: string): TaskDescription[] {
  return readdirSync(tasksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((id) => readTaskDescription(tasksDir, id));
}
