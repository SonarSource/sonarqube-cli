// Shared types for the UI module

export type ColorFn = (text: string) => string;

export type StepStatus =
  | 'done'     // ✓  green
  | 'running'  // →  cyan
  | 'failed'   // ✗  red
  | 'skipped'  // ⏭  dim
  | 'warn'     // ⚠  yellow
  | 'pending'  // ○  dim
  | 'info';    // ℹ  cyan

export interface PhaseItem {
  text: string;
  status: StepStatus;
  detail?: string;
}

export interface NoteOptions {
  borderColor?: ColorFn;
  titleColor?: ColorFn;
  contentColor?: ColorFn;
}

export interface PhaseOptions {
  titleColor?: ColorFn;
  iconColors?: Partial<Record<StepStatus, ColorFn>>;
}

export interface LogOptions {
  color?: ColorFn;
}
