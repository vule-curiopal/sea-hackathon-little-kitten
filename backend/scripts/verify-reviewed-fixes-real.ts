import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { parseArgs } from 'node:util';
import { AppError } from '../shared/types.js';
import { scenarios, SCENARIO_CATALOG_VERSION, validateScenarios } from '../evaluation/catalog.js';
import { fixVerificationScenarios } from '../evaluation/scenarios/fix-verification.js';
import { loadHistoricalSessions, runEvaluation } from '../evaluation/runner.js';
import { evaluateRun, EVALUATOR_VERSION, renderReport } from '../evaluation/evaluate.js';
import { judgeConversation, JUDGE_POLICY_VERSION } from '../evaluation/judge.js';
import { groupJudgeConversations, selectJudgeOperationalContext, selectJudgePriorContext } from '../evaluation/judge-context.js';
import { reviewKey } from '../evaluation/review-evidence.js';
import type { Scenario, SemanticReview, TurnLog } from '../evaluation/types.js';

const reviewedIds = new Set('012 016 018 019 020 026 032 034 036 042 043 050 061 063 080 092 095 098 099 100'.split(' ').map(id => 'SC-' + id));
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
async function jsonl<T>(path: string): Promise<T[]> {
  try { return (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line) as T); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
}
type Failure = { shard: number; stage: string; code: string; http_status: number | null; conversation?: string };
function failure(error: unknown, shard: number, stage: string, conversation?: string): Failure {
  const raw = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const status = typeof raw.status === 'number' && raw.status >= 400 && raw.status <= 599 ? raw.status : null;
  const code = error instanceof AppError ? error.code : raw.code === 'insufficient_quota' ? 'provider_quota_exceeded'
    : status === 401 || status === 403 ? 'provider_authentication_failed' : status === 429 ? 'provider_rate_limited' : 'request_or_validation_failed';
  return { shard, stage, code, http_status: status, ...(conversation ? { conversation } : {}) };
}
const counts = (report: ReturnType<typeof evaluateRun>) => Object.fromEntries(['pass', 'fail', 'needs_review'].map(status => [status, report.scenarios.filter(item => item.status === status).length]));
const issues = (report: ReturnType<typeof evaluateRun>) => report.scenarios.filter(item => item.status !== 'pass').flatMap(item => [
  '- ' + item.id + ': ' + item.status,
  ...[...item.failures, ...item.needs_review].slice(0, 8).map(item => '  - ' + item.turn_spec_id + ' / ' + item.check.id + ': ' + item.check.evidence.slice(0, 400)),
]);

async function main() {
  const { values } = parseArgs({ options: {
    suite: { type: 'string', default: 'reviewed' }, output: { type: 'string' }, shards: { type: 'string', default: '4' },
    'judge-model': { type: 'string' }, 'env-file': { type: 'string' }, 'source-manifest': { type: 'string' }, help: { type: 'boolean', default: false },
  } });
  if (values.help) {
    console.log('Usage: node --import tsx backend/scripts/verify-reviewed-fixes-real.ts --suite reviewed|full|remaining --output NEW_DIRECTORY [--shards 1..4] [--env-file LOCAL_ENV] [--judge-model MODEL] [--source-manifest FILE]');
    console.log('reviewed: 20 reviewed original cases + SC204/205; full: original SC001–100 + SC204/205; remaining: original 80 excluding the reviewed 20, without supplements. Real API calls; isolated in-memory databases; no production database.');
    return;
  }
  const shardCount = Number(values.shards);
  if (!['reviewed', 'full', 'remaining'].includes(values.suite) || !values.output || !Number.isSafeInteger(shardCount) || shardCount < 1 || shardCount > 4) throw new Error('Invalid suite, fresh output directory or shard count.');
  const envFile = resolve(values['env-file'] ?? (existsSync('local.env') ? 'local.env' : '.env'));
  const loadLocal = values['env-file'] !== undefined || !process.env.OPENAI_API_KEY;
  if (loadLocal && existsSync(envFile)) loadEnvFile(envFile);
  if (!process.env.OPENAI_API_KEY) throw new Error('Local real-provider credentials are required.');
  const judgeModel = values['judge-model'] ?? process.env.OPENAI_CHECK_MODEL ?? 'gpt-6-astra';
  if (!judgeModel.trim()) throw new Error('A real judge model is required.');
  const selected = [...scenarios.filter(item => Number(item.id.slice(3)) <= 100
    && (values.suite === 'full' || (values.suite === 'remaining' ? !reviewedIds.has(item.id) : reviewedIds.has(item.id)))),
    ...(values.suite === 'remaining' ? [] : fixVerificationScenarios)];
  validateScenarios(selected, selected.length);
  const history = await loadHistoricalSessions();
  const weight = (item: Scenario) => item.conversations.reduce((n, conversation) => n + conversation.turns.length, 0)
    + item.history_dates.reduce((n, date) => n + history.find(session => session.local_date === date)!.messages.filter(message => message.role === 'user').length, 0);
  const plan = Array.from({ length: shardCount }, (_, index) => ({ index: index + 1, weight: 0, scenarios: [] as Scenario[] }));
  for (const item of [...selected].sort((a, b) => weight(b) - weight(a))) {
    const target = [...plan].sort((a, b) => a.weight - b.weight || a.index - b.index)[0]!;
    target.scenarios.push(item); target.weight += weight(item);
  }
  const output = resolve(values.output);
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output, { recursive: false });
  const fullSpec = await readFile('docs/product-specification.md', 'utf8');
  const scope = 'This frozen runtime still implements legacy 30-day memory expiry. Explicit legacy expiry fixtures SC054/055 assess compatibility only; they do not establish the newly documented durable-memory or age-recall policy, which is not implemented by this run. Other reviewed fixes and exact authored criteria remain in scope.';
  const sourceFiles = (await readdir('backend', { recursive: true })).filter(path => /\.(?:ts|sql)$/u.test(path)).map(path => 'backend/' + path).sort();
  sourceFiles.push('docs/product-specification.md');
  const sourceText = values['source-manifest'] ? await readFile(resolve(values['source-manifest']), 'utf8')
    : json({ files: await Promise.all(sourceFiles.map(async path => ({ path, sha256: hash(await readFile(path, 'utf8')) }))) });
  JSON.parse(sourceText);
  await writeFile(resolve(output, 'source-manifest.json'), sourceText);
  const manifest = {
    status: 'running', started_at: new Date().toISOString(), completed_at: null as string | null, provider: 'real',
    suite: values.suite, history: 'none_with_selected_case_seeds', database: 'isolated_in_memory_pglite', audio: false,
    scenario_catalog_version: SCENARIO_CATALOG_VERSION, evaluator_version: EVALUATOR_VERSION, reviewer_policy_version: JUDGE_POLICY_VERSION,
    judge_model: judgeModel, credential_source: loadLocal ? 'explicit_local_environment_file' : 'already_loaded_environment',
    source_manifest_sha256: hash(sourceText), specification_sha256: hash(fullSpec), scenarios_sha256: hash(JSON.stringify(selected)),
    selected_scenarios: selected.map(item => item.id), expected_records: selected.reduce((n, item) => n + weight(item), 0),
    shards: plan.map(item => ({ index: item.index, expected_records: item.weight, scenario_ids: item.scenarios.map(item => item.id) })), scope,
  };
  await writeFile(resolve(output, 'manifest.json'), json(manifest));
  await writeFile(resolve(output, 'scenarios.json'), json({ version: SCENARIO_CATALOG_VERSION, supplements: 'SC204/205-fix-verification', scenarios: selected }));
  const errors: Failure[] = []; let stopJudging = false;
  const results = await Promise.all(plan.map(async shard => {
    const directory = resolve(output, 'shard-' + shard.index); const reviews: SemanticReview[] = [];
    let engine: Awaited<ReturnType<typeof runEvaluation>> | undefined;
    try {
      engine = await runEvaluation({ scenarios: shard.scenarios, provider: 'real', history: 'none', outputDir: directory,
        progress: message => console.log('Shard ' + shard.index + ': ' + message) });
      if (engine.blocked) { stopJudging = true; errors.push({ shard: shard.index, stage: engine.blocked.stage, code: engine.blocked.code, http_status: null }); }
    } catch (error) { stopJudging = true; errors.push(failure(error, shard.index, 'engine')); }
    const logs = await jsonl<TurnLog>(resolve(directory, 'turns.jsonl'));
    const reviewDirectory = resolve(directory, 'semantic-review');
    await mkdir(reviewDirectory, { recursive: false });
    for (const [key, conversation] of groupJudgeConversations(logs, true)) {
      if (stopJudging) break;
      try {
        const judged = await judgeConversation(conversation, selectJudgePriorContext(logs, conversation), {
          model: judgeModel, apiKey: process.env.OPENAI_API_KEY!, productSpecification: fullSpec + '\n\nEVALUATION SCOPE: ' + scope,
          operationalContext: selectJudgeOperationalContext(logs, conversation),
        });
        reviews.push(...judged);
        await writeFile(resolve(reviewDirectory, 'reviews.jsonl'), reviews.map(item => JSON.stringify(item)).join('\n') + '\n');
      } catch (error) {
        const item = failure(error, shard.index, 'judge', key); errors.push(item);
        if (item.http_status === 401 || item.http_status === 403 || item.http_status === 429 || item.code === 'provider_quota_exceeded') stopJudging = true;
      }
    }
    const report = evaluateRun(logs, reviews);
    await writeFile(resolve(reviewDirectory, 'report.json'), json(report));
    const apiCalls = logs.flatMap(item => [...(item.api_calls ?? []), ...(item.operational?.stale_replay?.api_calls ?? [])]);
    const provenance = { shard: shard.index, status: engine?.blocked ? 'blocked' : engine ? 'complete' : 'incomplete',
      scenario_ids: shard.scenarios.map(item => item.id), records: logs.length, reviews: reviews.length, api_calls: apiCalls.length,
      api_failures: apiCalls.filter(item => item.outcome !== 'completed').length, validity: report.validity,
      returned_models: [...new Set(apiCalls.map(item => item.returnedModel).filter(Boolean))] };
    await writeFile(resolve(reviewDirectory, 'manifest.json'), json({ ...provenance, reviewer_policy_version: JUDGE_POLICY_VERSION, errors: errors.filter(item => item.shard === shard.index) }));
    return { logs, reviews, provenance, conversations: await jsonl<unknown>(resolve(directory, 'conversations.jsonl')) };
  }));
  const logs = results.flatMap(item => item.logs).sort((a, b) => Number(a.scenario_id?.slice(3)) - Number(b.scenario_id?.slice(3)));
  const reviews = results.flatMap(item => item.reviews);
  const report = evaluateRun(logs, reviews);
  const cohort = (items: TurnLog[]) => { const keys = new Set(items.map(reviewKey)); return evaluateRun(items, reviews.filter(item => keys.has(item.key))); };
  const original = cohort(logs.filter(item => Number(item.scenario_id?.slice(3)) <= 100));
  const supplemental = cohort(logs.filter(item => Number(item.scenario_id?.slice(3)) > 100));
  for (const [name, value] of [['report', report], ['report-original-100-selected', original], ['report-supplements', supplemental]] as const) {
    await writeFile(resolve(output, name + '.json'), json(value));
    await writeFile(resolve(output, name + '.md'), renderReport(value));
  }
  for (const [name, rows] of [['turns', logs], ['reviews', reviews], ['conversations', results.flatMap(item => item.conversations)]] as const)
    await writeFile(resolve(output, name + '.jsonl'), rows.map(item => JSON.stringify(item)).join('\n') + (rows.length ? '\n' : ''));
  await writeFile(resolve(output, 'shard-provenance.json'), json(results.map(item => item.provenance)));
  await writeFile(resolve(output, 'errors.json'), json(errors));
  manifest.status = errors.length || logs.length !== manifest.expected_records ? 'incomplete' : 'complete';
  manifest.completed_at = new Date().toISOString();
  await writeFile(resolve(output, 'manifest.json'), json(manifest));
  await writeFile(resolve(output, 'SUMMARY.md'), [
    '# Reviewed-fix real evaluation', '', 'Suite: ' + values.suite + '. Raw results: ' + JSON.stringify(counts(report)) + '.',
    'Original-100 cohort: ' + original.scenarios.length + ' attempted; ' + JSON.stringify(counts(original)) + '. Supplements: ' + JSON.stringify(counts(supplemental)) + '.',
    'Recorded ' + logs.length + '/' + manifest.expected_records + ' expected turns; ' + report.semantic_reviews.accepted + ' matching reviews; ' + errors.length + ' sanitized orchestration/judge errors. Engine execution errors: ' + report.totals.execution_errors + ' (' + report.totals.expected_execution_errors + ' expected negatives).',
    'Source manifest SHA-256: ' + manifest.source_manifest_sha256 + '.', '', '## Failures and unresolved issues', '',
    ...(issues(report).length ? issues(report) : ['No failed or unresolved recorded scenario checks.']), '', '## Scope', '', scope,
    'All replies came from the real application path with isolated in-memory databases. Model judgments are advisory; missing reviews remain needs_review. Audio/UI and production behavior are not tested. Existing runs are unchanged.',
  ].join('\n') + '\n');
  console.log('Saved real evaluation evidence to ' + output);
  if (manifest.status !== 'complete' || report.scenarios.some(item => item.status !== 'pass')) process.exitCode = 1;
}
main().catch(() => { console.error('Reviewed-fix evaluation could not complete; inspect fresh sanitized artifacts if created. No fake fallback was used.'); process.exitCode = 1; });
