export const TASKS_PAGE_URL = 'https://internal.sip.sonarsource.io/apps/harbor-tasks/';

const TITLES: Record<string, string> = {
  'integrate--happy': 'Set up SonarQube for the coding agent',
  'auth--missing-org': 'Repair the CLI, then count the open issues',
  'secrets-context--prompt': 'A key typed directly in the prompt',
  'secrets-context--file-read': 'A key hidden inside a file the agent reads',
};

export function taskTitle(task: string): string {
  return TITLES[task] ?? task;
}
