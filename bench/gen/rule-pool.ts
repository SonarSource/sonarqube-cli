const RULE_KEY_TEMPLATES = [
  'typescript:S1854',
  'typescript:S2589',
  'typescript:S3776',
  'typescript:S4325',
  'java:S2259',
  'java:S1481',
  'java:S1192',
  'typescript:S6660',
  'typescript:S6606',
  'java:S3776',
];

const RULE_POOL_SIZE = 200;

export interface WeightedRule {
  ruleKey: string;
  message: string;
  weight: number;
}

function buildRuleKey(index: number): string {
  const template = RULE_KEY_TEMPLATES[index % RULE_KEY_TEMPLATES.length];
  const [lang, code] = template.split(':');
  return `${lang}:S${1000 + index}${code.slice(1)}`;
}

// Zipf-ish weighting so a handful of rules dominate, mirroring the real "You keep hitting
// these issues" report where the top 5 rules are a small share of a much larger rule set.
export const RULE_POOL: readonly WeightedRule[] = Array.from(
  { length: RULE_POOL_SIZE },
  (_, i) => ({
    ruleKey: buildRuleKey(i),
    message: `Synthetic finding message for rule ${i}`,
    weight: 1 / (i + 1),
  }),
);

export const RULE_POOL_TOTAL_WEIGHT = RULE_POOL.reduce((sum, r) => sum + r.weight, 0);
