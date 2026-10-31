import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { parseArgs } from 'node:util';
import { scenarios } from '../evaluation/catalog.js';
import { evaluateRun, renderReport } from '../evaluation/evaluate.js';
import { judgeConversation } from '../evaluation/judge.js';
import { runEvaluation } from '../evaluation/runner.js';
import type { SemanticReview, TurnLog } from '../evaluation/types.js';
import { AppError } from '../shared/types.js';

const { values } = parseArgs({ options: {
  output: { type: 'string' }, concurrency: { type: 'string', default: '4' },
  scenario: { type: 'string', multiple: true }, 'judge-model': { type: 'string' },
  'fail-on': { type: 'string', default: 'fail' },
  help: { type: 'boolean', default: false },
} });
if (values.help) {
  console.log('Usage: npm run eval:quick -- [--output NEW_DIRECTORY] [--concurrency 1..4] [--scenario SC-011] [--judge-model MODEL] [--fail-on none|fail|review]');
  process.exit(0);
}
if (existsSync('.env')) loadEnvFile('.env');
if (!process.env.OPENAI_API_KEY) throw new Error('Real-model verification requires OPENAI_API_KEY.');
const concurrency = Number(values.concurrency);
if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('--concurrency must be 1..4');
if (!['none', 'fail', 'review'].includes(values['fail-on'])) throw new Error('--fail-on must be none, fail or review');
// Each scenario preserves its multi-day causal chain. Every worker owns its own database.
const ids = values.scenario ?? ['SC-011', 'SC-041', 'SC-048', 'SC-058', 'SC-061', 'SC-072'];
if (!ids.length || new Set(ids).size !== ids.length) throw new Error('Select unique scenario IDs.');
const selected = ids.map(id => {
  const scenario = scenarios.find(item => item.id === id);
  if (!scenario) throw new Error(`Unknown scenario ${id}`);
  return scenario;
});
const output = resolve(values.output ?? `backend/evaluation/runs/contest-${new Date().toISOString().replace(/[:.]/gu, '-')}`);
await mkdir(resolve(output, '..'), { recursive: true });
await mkdir(output, { recursive: false });
const started = Date.now();
const logs: TurnLog[] = [];
const reviews: SemanticReview[] = [];
const results: { id: string; status: string; turns: number }[] = [];
const errors: { scenario: string; stage: string; code: string }[] = [];
const specification = values['judge-model']
  ? (await readFile(resolve('docs/product-specification.md'), 'utf8')).split(/\n(?=## \d+ )/u)
    .filter(section => /^## (?:2|4|5|7|8|9|10|11|13|15|16) /u.test(section)).join('\n')
  : '';
let next = 0;
async function save(status: string) {
  const report = evaluateRun(logs, reviews);
  await writeFile(resolve(output, 'turns.jsonl'), logs.map(log => JSON.stringify(log)).join('\n') + (logs.length ? '\n' : ''));
  await writeFile(resolve(output, 'reviews.jsonl'), reviews.map(review => JSON.stringify(review)).join('\n') + (reviews.length ? '\n' : ''));
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(resolve(output, 'report.md'), renderReport(report));
  const checkerRejections = logs.flatMap(log => log.provider_events.filter(event => event.stage === 'check' && event.outcome === 'ok')
    .flatMap(event => {
      const verdict = event.details as { approved?: boolean; violations?: string[] } | undefined;
      return verdict?.approved === false ? [{ scenario: log.scenario_id, turn: log.turn_spec_id, violations: verdict.violations ?? [] }] : [];
    }));
  await writeFile(resolve(output, 'diagnostics.json'), JSON.stringify({
    execution_errors: logs.filter(log => log.error).map(log => ({ scenario: log.scenario_id, turn: log.turn_spec_id, ...log.error })),
    checker_rejections: checkerRejections,
    scenario_assertions: report.totals.scenario_assertions,
    semantic_reviews: report.semantic_reviews,
    note: 'Checker rejections require inspection of context and actual candidates; neither acceptance nor rejection alone establishes dialogue quality.',
  }, null, 2) + '\n');
  await writeFile(resolve(output, 'manifest.json'), JSON.stringify({
    run_kind: 'character_memory_evaluation', provider: 'real', scope: 'contest_smoke',
    status, scenarios: ids, concurrency, completed_scenarios: results,
    elapsed_ms: Date.now() - started, judge_model: values['judge-model'] ?? null, errors,
    behavior: report.totals,
    limitations: ['Focused scenario coverage; this does not verify the full historical year.',
      'Sequential turns and isolated databases preserve causality within each scenario.',
      'Semantic criteria without a successful independent review remain needs_review.',
      'Text path only; playback receipts are simulated.'],
  }, null, 2) + '\n');
}
await save('running');
// Serialize aggregate writes while separate engine workers make real requests concurrently.
let journal: Promise<void> = Promise.resolve();
await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, async () => {
  while (next < selected.length) {
    const scenario = selected[next++]!;
    console.log(`Starting ${scenario.id}: ${scenario.title}`);
    try {
      const run = await runEvaluation({ scenarios: [scenario], provider: 'real', history: 'none', outputDir: resolve(output, scenario.id) });
      const scenarioLogs = (await readFile(resolve(run.outputDir, 'turns.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as TurnLog);
      logs.push(...scenarioLogs);
      results.push({ id: scenario.id, status: run.blocked ? 'blocked' : 'completed', turns: scenarioLogs.length });
      if (run.blocked) errors.push({ scenario: scenario.id, stage: 'engine', code: run.blocked.code });
      if (values['judge-model']) {
        for (const conversation of scenario.conversations) {
          const current = scenarioLogs.filter(log => log.phase === 'scenario' && log.conversation_id === conversation.id);
          if (!current.length) continue;
          const prior = scenarioLogs.slice(0, scenarioLogs.indexOf(current[0]!));
          try {
            reviews.push(...await judgeConversation(current, prior, { model: values['judge-model'], apiKey: process.env.OPENAI_API_KEY!, productSpecification: specification }));
          } catch {
            errors.push({ scenario: scenario.id, stage: 'judge', code: 'judge_request_or_validation_failed' });
          }
        }
      }
      console.log(`Finished ${scenario.id}; ${scenarioLogs.length} real turn records. ${results.length}/${selected.length} scenarios.`);
    } catch (error) {
      // Preserve safe partial evidence; raw transport error messages may contain secrets.
      let partial: TurnLog[] = [];
      try {
        partial = (await readFile(resolve(output, scenario.id, 'turns.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as TurnLog);
      } catch { /* No complete turn record was available. */ }
      if (!results.some(result => result.id === scenario.id)) logs.push(...partial);
      errors.push({ scenario: scenario.id, stage: 'engine', code: error instanceof AppError ? error.code : 'scenario_execution_failed' });
      const result = results.find(item => item.id === scenario.id);
      if (result) result.status = 'error';
      else results.push({ id: scenario.id, status: 'error', turns: partial.length });
      console.log(`${scenario.id} could not complete; recorded as unresolved.`);
    }
    journal = journal.then(() => save('running'));
    await journal;
  }
}));
const finalReport = evaluateRun(logs, reviews);
await save(errors.length ? 'completed_with_unresolved_errors' : finalReport.totals.fail ? 'completed_with_failures' : 'completed');
console.log(`Saved contest verification to ${output}`);
console.log(JSON.stringify(finalReport.totals));
if (errors.length || values['fail-on'] !== 'none' && finalReport.totals.fail > 0
  || values['fail-on'] === 'review' && finalReport.totals.needs_review > 0) process.exitCode = 1;
