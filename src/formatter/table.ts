// Table formatter for terminal output

import type { SonarQubeIssue } from '../lib/types.js';

export function formatTable(issues: SonarQubeIssue[]): string {
  if (issues.length === 0) {
    return 'No issues found';
  }

  // Calculate column widths
  const severityWidth = Math.max(8, ...issues.map(i => i.severity.length));
  const ruleWidth = Math.max(15, ...issues.map(i => i.rule.length));
  const messageWidth = Math.max(50, ...issues.map(i => i.message.length));

  // Header
  const header = [
    'SEVERITY'.padEnd(severityWidth),
    'RULE'.padEnd(ruleWidth),
    'MESSAGE'.padEnd(messageWidth),
    'FILE'
  ].join(' | ');

  const separator = '-'.repeat(header.length);

  const lines = [header, separator];

  // Rows
  for (const issue of issues) {
    const file = issue.component.split(':').pop() || issue.component;
    const line = [
      issue.severity.padEnd(severityWidth),
      issue.rule.padEnd(ruleWidth),
      issue.message.substring(0, messageWidth).padEnd(messageWidth),
      `${file}:${issue.line || '?'}`
    ].join(' | ');
    lines.push(line);
  }

  return lines.join('\n');
}
