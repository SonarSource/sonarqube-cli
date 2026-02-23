// Public API for the UI module

export { info, success, warn, error, text, print, blank } from './messages.js';
export { note } from './components/note.js';
export { phase, phaseItem } from './components/phase.js';
export type { PhaseItem, StepStatus } from './components/phase.js';
export { intro, outro } from './components/sections.js';
export { setMockUi, isMockActive, getMockUiCalls, clearMockUiCalls, queueMockResponse, clearMockResponses } from './mock.js';
export type { UiCall } from './mock.js';
export type { NoteOptions, PhaseOptions, LogOptions, ColorFn } from './types.js';
export { withSpinner } from './components/spinner.js';
export { textPrompt, confirmPrompt, pressEnterPrompt } from './components/prompts.js';
