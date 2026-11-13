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

const CHECKS: Record<string, string> = {
  integration_installed: 'The integration for this agent is installed',
  no_other_integration: 'No other integration is installed',
  answer_correct: 'The number in answer.txt is the real count of open issues',
  list_issues_ran: 'The agent ran sonar list issues itself',
  no_interactive_login: 'The agent did not start an interactive login',
  secret_not_in_config: 'The key is not in config.json',
  secret_not_in_agent_output: 'The key does not appear in anything the agent wrote',
  prompt_blocked: 'The prompt that contained the key was blocked',
  hook_ran: 'The Sonar hook ran',
  read_env_file: 'The agent opened config/.env.local',
};

export function checkSentence(key: string): string | null {
  return CHECKS[key] ?? null;
}
