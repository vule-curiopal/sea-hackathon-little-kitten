import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { evaluateRun, renderReport } from '../evaluation/evaluate.js';
import { judgeConversation } from '../evaluation/judge.js';
import { selectJudgePriorContext } from '../evaluation/judge-context.js';
import type { SemanticReview, TurnLog } from '../evaluation/types.js';

const { values } = parseArgs({ options: {
  input: { type: 'string' }, output: { type: 'string' }, model: { type: 'string' },
  limit: { type: 'string' }, concurrency: { type: 'string', default: '2' }, help: { type: 'boolean', default: false },
} });
if (values.help) {
  console.log('Usage: npm run eval:judge -- --input PATH/turns.jsonl --model MODEL --output NEW_DIRECTORY [--limit CONVERSATIONS] [--concurrency 1..4]');
  process.exit(0);
}
if (!values.input || !values.model || !values.output) throw new Error('--input, --model and --output are required; model judging is always explicit.');
if (!process.env.OPENAI_API_KEY) throw new Error('Model judging requires OPENAI_API_KEY; load an env file explicitly.');
const concurrency = Number(values.concurrency);
const limit = values.limit === undefined ? Infinity : Number(values.limit);
if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('--concurrency must be 1..4');
if (values.limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error('--limit must be a positive integer');
const input = resolve(values.input);
const logs = (await readFile(input, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line) as TurnLog);
if (!logs.length || logs.some(log => log.schema_version !== 'miu-engine-evaluation-v1' || !Array.isArray(log.rubric))) throw new Error('Invalid engine log format');
if (logs.some(log => log.provider_mode !== 'real')) throw new Error('Model evaluation requires real-provider replies; fake diagnostics cannot be judged as model performance.');
const groups = new Map<string, TurnLog[]>();
for (const log of logs.filter(log => log.phase === 'scenario')) {
  const key = `${log.run_id}/${log.scenario_id}/${log.conversation_id}`;
  groups.set(key, [...(groups.get(key) ?? []), log]);
}
const selected = [...groups.entries()].slice(0, limit);
const spec = await readFile(fileURLToPath(new URL('../../docs/product-specification.md', import.meta.url)), 'utf8');
const sections = spec.split(/\n(?=## \d+ )/u);
const relevantSpec = sections.filter(section => /^## (?:2|4|5|7|8|9|10|11|13|15|16) /u.test(section)).join('\n');
const output = resolve(values.output);
await mkdir(resolve(output, '..'), { recursive: true });
await mkdir(output, { recursive: false });
const reviewFile = await open(resolve(output, 'reviews.jsonl'), 'wx');
const errors: { conversation: string; error: string }[] = [];
const reviews: SemanticReview[] = [];
let next = 0;
let finished = 0;
let journal: Promise<unknown> = Promise.resolve();
try {
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < selected.length) {
      const [key, conversation] = selected[next++]!;
      const prior = selectJudgePriorContext(logs, conversation);
      try {
        const decisions = await judgeConversation(conversation, prior, { model: values.model!, apiKey: process.env.OPENAI_API_KEY!, productSpecification: relevantSpec });
        reviews.push(...decisions);
        journal = journal.then(() => reviewFile.write(`${decisions.map(decision => JSON.stringify(decision)).join('\n')}\n`));
        await journal;
      } catch {
        // Never record raw API errors, headers, credentials, or treat a judge outage as a pass.
        errors.push({ conversation: key, error: 'judge_request_or_validation_failed' });
      }
      finished++;
      console.log(`Judged ${finished}/${selected.length} conversations; ${errors.length} unresolved judge errors.`);
    }
  }));
} finally { await reviewFile.close(); }
const report = evaluateRun(logs, reviews);
await writeFile(resolve(output, 'judge-manifest.json'), `${JSON.stringify({
  synthetic: true, source_engine_log: input, model: values.model, store: false,
  requested_conversations: selected.length, reviewed_turns: reviews.length, errors,
  note: 'Model judgments are fallible evidence. Independent check failures cannot be overridden. Missing, malformed or stale judgments remain needs_review.',
}, null, 2)}\n`);
await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(resolve(output, 'report.md'), renderReport(report));
console.log(`Saved independent semantic reviews and combined reports to ${output}`);
if (errors.length) process.exitCode = 1;
