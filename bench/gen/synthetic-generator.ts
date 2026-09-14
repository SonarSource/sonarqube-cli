import { RULE_POOL, RULE_POOL_TOTAL_WEIGHT } from './rule-pool.ts';
import type {
  SyntheticAnalyzer,
  SyntheticStatsEvent,
  SyntheticTrigger,
} from './synthetic-event.ts';

// mulberry32 — small, fast, deterministic PRNG. Same seed => same sequence every run/backend.
// `|0` here is intentional ToInt32 wraparound (the algorithm's 32-bit overflow behavior), not a
// sloppy Math.trunc substitute — Math.trunc would not wrap and would break the sequence.
const MULBERRY32_INCREMENT = 0x6d2b79f5;

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + MULBERRY32_INCREMENT) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RULE_CUMULATIVE_WEIGHTS: readonly number[] = (() => {
  let running = 0;
  return RULE_POOL.map((r) => (running += r.weight));
})();

function pickRuleIndex(rand: () => number): number {
  const target = rand() * RULE_POOL_TOTAL_WEIGHT;
  let lo = 0;
  let hi = RULE_CUMULATIVE_WEIGHTS.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (RULE_CUMULATIVE_WEIGHTS[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function pickWeighted<T>(rand: () => number, entries: ReadonlyArray<readonly [T, number]>): T {
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let target = rand() * total;
  for (const [value, weight] of entries) {
    target -= weight;
    if (target <= 0) return value;
  }
  return entries.at(-1)![0];
}

const ANALYZER_WEIGHTS: ReadonlyArray<readonly [SyntheticAnalyzer, number]> = [
  ['sonar-secrets', 0.15],
  ['sqaa', 0.6],
  ['sca-scanner-cli', 0.25],
];

const CALLER_COMMANDS_BY_ANALYZER: Record<
  SyntheticAnalyzer,
  ReadonlyArray<readonly [string, number]>
> = {
  'sonar-secrets': [
    ['git-pre-commit', 0.4],
    ['git-pre-push', 0.15],
    ['agent-prompt-submit', 0.2],
    ['claude-pre-tool-use', 0.15],
    ['analyze secrets', 0.1],
  ],
  sqaa: [
    ['claude-post-tool-use', 0.5],
    ['codex-post-tool-use', 0.2],
    ['analyze agentic', 0.2],
    ['verify', 0.1],
  ],
  'sca-scanner-cli': [
    ['git-pre-commit', 0.3],
    ['analyze dependency-risks', 0.7],
  ],
};

const AGENT_WEIGHTS: ReadonlyArray<readonly [string, number]> = [
  ['claude', 0.46],
  ['cursor', 0.22],
  ['unidentified', 0.21],
  ['codex', 0.08],
  ['copilot', 0.03],
  ['antigravity', 0.01],
];

const MANUAL_CALLER_COMMANDS = new Set([
  'analyze secrets',
  'analyze agentic',
  'analyze dependency-risks',
  'verify',
]);

const DAY_MS = 86_400_000;
const SPAN_DAYS = 365;
const HIT_RATE = 0.34; // share of runs that surface at least one finding, matching the real report
const MIN_DURATION_MS = 50;
const DURATION_JITTER_MS = 5000;
// Mirrors the real product's SECRETS_BLOCKED_EXIT_CODE (src/core/stats/stats-queries.ts).
const SECRETS_FOUND_EXIT_CODE = 51;

function buildRuleCounts(rand: () => number): {
  ruleCounts: Record<string, number>;
  findingsCount: number;
} {
  if (rand() > HIT_RATE) {
    return { ruleCounts: {}, findingsCount: 0 };
  }
  const distinctRules = 1 + Math.floor(rand() * 4); // 1-4 distinct rules per run with findings
  const ruleCounts: Record<string, number> = {};
  let findingsCount = 0;
  for (let i = 0; i < distinctRules; i++) {
    const rule = RULE_POOL[pickRuleIndex(rand)];
    const count = 1 + Math.floor(rand() * 5);
    ruleCounts[rule.ruleKey] = (ruleCounts[rule.ruleKey] ?? 0) + count;
    findingsCount += count;
  }
  return { ruleCounts, findingsCount };
}

export function* generateSyntheticEvents(
  count: number,
  seed: number,
): Generator<SyntheticStatsEvent, void, void> {
  const rand = mulberry32(seed);
  const now = Date.now();
  const spanMs = SPAN_DAYS * DAY_MS;
  const startMs = now - spanMs;
  // Real usage is an append-only ledger: rows are written in roughly wall-clock order, so
  // increasing id correlates with increasing timestampMs (with local jitter for concurrent
  // writers), not a uniformly random shuffle across the whole span independent of insertion
  // order. A fully-random timestamp would give every backend's timestamp-range index scan a
  // synthetic worst case (random-access row lookups) that real usage never actually hits.
  const avgSlotMs = count > 1 ? spanMs / (count - 1) : 0;
  const JITTER_WINDOW_FACTOR = 4;

  for (let id = 1; id <= count; id++) {
    const idealMs = startMs + (id - 1) * avgSlotMs;
    const jitterMs = (rand() - 0.5) * avgSlotMs * JITTER_WINDOW_FACTOR;
    const timestampMs = Math.min(now, Math.max(startMs, Math.round(idealMs + jitterMs)));
    const analyzer = pickWeighted(rand, ANALYZER_WEIGHTS);
    const callerCommand = pickWeighted(rand, CALLER_COMMANDS_BY_ANALYZER[analyzer]);
    const callerAgent = pickWeighted(rand, AGENT_WEIGHTS);
    const runTrigger: SyntheticTrigger = MANUAL_CALLER_COMMANDS.has(callerCommand)
      ? 'manual'
      : 'hooks';
    const { ruleCounts, findingsCount } = buildRuleCounts(rand);
    const durationMs = MIN_DURATION_MS + Math.floor(rand() * DURATION_JITTER_MS);
    const exitCode =
      findingsCount > 0 && analyzer === 'sonar-secrets' ? SECRETS_FOUND_EXIT_CODE : 0;

    yield {
      id,
      timestampMs,
      analyzer,
      callerCommand,
      exitCode,
      callerAgent,
      runTrigger,
      durationMs,
      findingsCount,
      ruleCounts,
    };
  }
}
