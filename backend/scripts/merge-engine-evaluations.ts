import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { evaluateRun, EVALUATOR_VERSION, renderReport } from '../evaluation/evaluate.js';
import { JUDGE_POLICY_VERSION } from '../evaluation/judge.js';
import { loadHistoricalSessions } from '../evaluation/runner.js';
import { reviewEvidenceHash, reviewKey } from '../evaluation/review-evidence.js';
import type { Scenario, SemanticReview, TurnLog } from '../evaluation/types.js';

// Post-processing only: no provider, credential loader, database or engine is invoked.
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const encode = (value: unknown) => JSON.stringify(value, null, 2) + '\n';
const reviewedIds = new Set('012 016 018 019 020 026 032 034 036 042 043 050 061 063 080 092 095 098 099 100'.split(' ').map(id => 'SC-' + id));
const expectedIds = [...Array.from({ length: 100 }, (_, n) => 'SC-' + String(n + 1).padStart(3, '0')), 'SC-204', 'SC-205'];
class MergeRejected extends Error {}
function ensure(condition: unknown, message: string): asserts condition { if (!condition) throw new MergeRejected(message); }
const parseLines = <T>(raw: Buffer): T[] => {
  ensure(raw.length > 0 && raw.at(-1) === 10, 'JSONL evidence must be nonempty and newline-terminated.');
  return raw.toString('utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as T);
};
const counts = (report: ReturnType<typeof evaluateRun>) => Object.fromEntries(['pass', 'fail', 'needs_review'].map(status => [status, report.scenarios.filter(item => item.status === status).length]));
type ParentManifest = {
  status: string; provider: string; suite: string; source_manifest_sha256: string; specification_sha256: string;
  scenario_catalog_version: string; evaluator_version: string; reviewer_policy_version: string; judge_model: string;
  selected_scenarios: string[]; expected_records: number; scenarios_sha256: string; scope: string;
  shards: { index: number; scenario_ids: string[] }[];
};
async function parent(path: string, suite: string) {
  const directory = resolve(path), manifestRaw = await readFile(resolve(directory, 'manifest.json'));
  const manifest = JSON.parse(manifestRaw.toString()) as ParentManifest;
  ensure(manifest.status === 'complete' && manifest.provider === 'real' && manifest.suite === suite, 'Parents must be completed real reviewed/remaining suites.');
  ensure(manifest.evaluator_version === EVALUATOR_VERSION && manifest.reviewer_policy_version === JUDGE_POLICY_VERSION, 'Parent evaluator/reviewer version differs from this merger.');
  const sourceRaw = await readFile(resolve(directory, 'source-manifest.json'));
  ensure(sha(sourceRaw) === manifest.source_manifest_sha256, 'Parent source-manifest hash does not match its bytes.');
  const source = JSON.parse(sourceRaw.toString()) as { files: { path: string; sha256: string }[] };
  ensure(Array.isArray(source.files) && source.files.length > 0, 'Missing source fingerprints.');
  const sources = new Map(source.files.map(file => [file.path, file.sha256]));
  ensure(sources.get('docs/product-specification.md') === manifest.specification_sha256, 'Product specification differs from frozen source.');
  for (const file of ['backend/evaluation/evaluate.ts', 'backend/evaluation/review-evidence.ts']) {
    ensure(sources.get(file) === sha(await readFile(file)), 'Run this merger beside the frozen evaluator and evidence hasher.');
  }
  const caseFile = JSON.parse(await readFile(resolve(directory, 'scenarios.json'), 'utf8')) as { version: string; scenarios: Scenario[] };
  ensure(caseFile.version === manifest.scenario_catalog_version && sha(JSON.stringify(caseFile.scenarios)) === manifest.scenarios_sha256, 'Parent case definitions do not match the manifest.');
  ensure(isDeepStrictEqual(caseFile.scenarios.map(item => item.id), manifest.selected_scenarios), 'Selected case IDs differ from persisted definitions.');
  ensure(new Set(manifest.selected_scenarios).size === manifest.selected_scenarios.length, 'Duplicate case ID in parent.');
  const expected = suite === 'reviewed' ? [...reviewedIds, 'SC-204', 'SC-205'] : expectedIds.filter(id => Number(id.slice(3)) <= 100 && !reviewedIds.has(id));
  ensure(isDeepStrictEqual([...manifest.selected_scenarios].sort(), expected.sort()), 'Reviewed/remaining case partition is incomplete or contains extras.');
  const historyHashes = new Set<string>(), shardRunIds = new Set<string>();
  for (const shard of manifest.shards) {
    const item = JSON.parse(await readFile(resolve(directory, 'shard-' + shard.index, 'manifest.json'), 'utf8'));
    ensure(item.status === 'complete' && item.provider === 'real' && item.run_kind === 'character_memory_evaluation', 'An engine shard is incomplete or not real evaluation.');
    ensure(item.evaluator_version === manifest.evaluator_version && item.scenario_catalog_version === manifest.scenario_catalog_version, 'Shard version mismatch.');
    ensure(item.spec_sha256 === manifest.specification_sha256, 'Shard specification mismatch.');
    for (const file of item.implementation_files as { path: string; sha256: string }[])
      ensure(sources.get('backend/' + file.path) === file.sha256, 'An actual engine implementation fingerprint differs from the source manifest.');
    historyHashes.add(item.history_sha256); shardRunIds.add(item.run_id);
  }
  ensure(historyHashes.size === 1, 'Shards used different historical corpora.');
  const turnsRaw = await readFile(resolve(directory, 'turns.jsonl')), reviewsRaw = await readFile(resolve(directory, 'reviews.jsonl'));
  const conversationsRaw = await readFile(resolve(directory, 'conversations.jsonl'));
  const logs = parseLines<TurnLog>(turnsRaw), reviews = parseLines<SemanticReview>(reviewsRaw);
  const conversations = parseLines<{ phase: string; scenario_id: string; conversation_id: string; profile_key: string; turns: number; errors: number }>(conversationsRaw);
  ensure(logs.length === manifest.expected_records, 'Parent turn coverage is incomplete.');
  ensure(logs.every(log => log.provider_mode === 'real' && log.run_kind === 'character_memory_evaluation' && shardRunIds.has(log.run_id)
    && log.scenario_id !== null && manifest.selected_scenarios.includes(log.scenario_id)), 'Log has foreign, unverified or non-real records.');
  ensure(new Set(logs.map(reviewKey)).size === logs.length && new Set(reviews.map(review => review.key)).size === reviews.length, 'Duplicate turn/review keys.');
  const byKey = new Map(logs.map(log => [reviewKey(log), log]));
  ensure(reviews.length === logs.length && reviews.every(review => {
    const log = byKey.get(review.key);
    return log && review.source === 'model' && review.reviewer === manifest.judge_model && review.evidence_sha256 === reviewEvidenceHash(log);
  }), 'Reviews are missing, foreign or not bound to exact real evidence.');
  const report = evaluateRun(logs, reviews);
  ensure(report.validity.character_memory_quality_evidence && report.semantic_reviews.accepted === logs.length
    && report.semantic_reviews.rejected_or_unmatched === 0, 'Real reply provenance or complete semantic-review validation failed.');
  const errors = JSON.parse(await readFile(resolve(directory, 'errors.json'), 'utf8'));
  ensure(Array.isArray(errors) && errors.length === 0, 'Parent has unresolved orchestration/judge errors.');
  return { directory, manifest, manifestRaw, sourceRaw, cases: caseFile.scenarios, logs, reviews, turnsRaw, reviewsRaw, conversationsRaw, conversations, historyHash: [...historyHashes][0]! };
}

async function main() {
  const { values } = parseArgs({ options: { reviewed: { type: 'string' }, remaining: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean', default: false } } });
  if (values.help) {
    console.log('Usage: node --import tsx backend/scripts/merge-engine-evaluations.ts --reviewed REVIEWED_DIR --remaining REMAINING_DIR --output NEW_DIRECTORY');
    console.log('Read-only validation/merge of identical frozen-source real runs: original SC001–100 plus SC204/205. No provider calls; parent evidence bytes remain unchanged.');
    return;
  }
  ensure(values.reviewed && values.remaining && values.output, '--reviewed, --remaining and a fresh --output are required.');
  const parents = await Promise.all([parent(values.reviewed, 'reviewed'), parent(values.remaining, 'remaining')]);
  const [reviewed, remaining] = parents;
  ensure(reviewed!.manifest.source_manifest_sha256 === remaining!.manifest.source_manifest_sha256, 'Engine source manifests differ; cannot combine different fixes.');
  for (const field of ['scenario_catalog_version', 'evaluator_version', 'reviewer_policy_version', 'judge_model', 'specification_sha256', 'scope'] as const)
    ensure(reviewed!.manifest[field] === remaining!.manifest[field], 'Parent evaluation configuration differs: ' + field);
  ensure(reviewed!.historyHash === remaining!.historyHash, 'Parent historical corpora differ.');
  const cases = parents.flatMap(item => item.cases), ids = cases.map(item => item.id);
  ensure(new Set(ids).size === ids.length && isDeepStrictEqual([...ids].sort(), [...expectedIds].sort()), 'Cases overlap or full original-100 plus supplements are missing.');
  const history = await loadHistoricalSessions();
  ensure(sha(JSON.stringify(history)) === reviewed!.historyHash, 'Local source archive differs; cannot verify seed coverage.');
  const logs = parents.flatMap(item => item.logs), reviews = parents.flatMap(item => item.reviews);
  const turnKey = (item: Pick<TurnLog, 'phase' | 'scenario_id' | 'conversation_id' | 'turn_spec_id' | 'profile_key'>) => [item.phase, item.scenario_id, item.conversation_id, item.turn_spec_id, item.profile_key].join('/');
  const actual = new Map(logs.map(log => [turnKey(log), log])), expected = new Set<string>();
  ensure(actual.size === logs.length, 'Repeated scenario turn evidence.');
  for (const scenario of cases) {
    for (const conversation of scenario.conversations) for (const turn of conversation.turns) {
      const key = turnKey({ phase: 'scenario', scenario_id: scenario.id, conversation_id: conversation.id, turn_spec_id: turn.id, profile_key: conversation.profile });
      expected.add(key); const log = actual.get(key);
      const input = { kind: turn.kind ?? 'utterance', ...(turn.text ? { text: turn.text } : {}) };
      ensure(log && isDeepStrictEqual(log.input, input) && isDeepStrictEqual(log.assertions, turn.assertions) && isDeepStrictEqual(log.rubric, turn.rubric), 'Missing or changed authored turn: ' + key);
    }
    for (const date of scenario.history_dates) {
      const session = history.find(item => item.local_date === date);
      ensure(session, 'Missing seed date in source archive.');
      for (const message of session.messages.filter(item => item.role === 'user')) {
        const key = turnKey({ phase: 'scenario_history', scenario_id: scenario.id, conversation_id: session.session_id, turn_spec_id: message.id, profile_key: 'an' });
        expected.add(key); const log = actual.get(key);
        ensure(log && log.source_message_id === message.id && isDeepStrictEqual(log.input, { kind: 'utterance', text: message.content })
          && log.rubric.length === 0 && log.assertions.length === 0, 'Missing or changed historical user-only seed: ' + key);
      }
    }
  }
  ensure(logs.length === expected.size && [...actual.keys()].every(key => expected.has(key)), 'Extra, missing or standalone-history turns.');
  const conversationKey = (item: { phase: string; scenario_id: string | null; conversation_id: string; profile_key: string }) => [item.phase, item.scenario_id, item.conversation_id, item.profile_key].join('/');
  const groups = new Map<string, TurnLog[]>();
  for (const log of logs) groups.set(conversationKey(log), [...(groups.get(conversationKey(log)) ?? []), log]);
  const conversations = parents.flatMap(item => item.conversations);
  ensure(new Set(conversations.map(conversationKey)).size === groups.size && conversations.length === groups.size
    && conversations.every(item => { const turns = groups.get(conversationKey(item)); return turns && turns.length === item.turns && turns.filter(turn => turn.error).length === item.errors; }), 'Conversation coverage/receipt metadata is incomplete.');
  const report = evaluateRun(logs, reviews), cohort = (items: TurnLog[]) => {
    const keys = new Set(items.map(reviewKey)); return evaluateRun(items, reviews.filter(item => keys.has(item.key)));
  };
  const original = cohort(logs.filter(item => Number(item.scenario_id!.slice(3)) <= 100));
  const supplemental = cohort(logs.filter(item => Number(item.scenario_id!.slice(3)) > 100));
  const output = resolve(values.output);
  ensure(parents.every(item => output !== item.directory && !output.startsWith(item.directory + sep)), 'Output must be outside immutable parent directories.');
  await mkdir(dirname(output), { recursive: true }); await mkdir(output, { recursive: false });
  const write = (name: string, value: string | Buffer) => writeFile(resolve(output, name), value, { flag: 'wx' });
  for (const [name, value] of [['turns.jsonl', 'turnsRaw'], ['reviews.jsonl', 'reviewsRaw'], ['conversations.jsonl', 'conversationsRaw']] as const)
    await write(name, Buffer.concat(parents.map(item => item[value])));
  await write('source-manifest.json', reviewed!.sourceRaw);
  const apiCalls = logs.flatMap(item => [...(item.api_calls ?? []), ...(item.operational?.stale_replay?.api_calls ?? [])]);
  const manifest = { status: 'complete', operation: 'read_only_evidence_merge', created_at: new Date().toISOString(), provider: 'real',
    source_manifest_sha256: sha(reviewed!.sourceRaw), merger_sha256: sha(await readFile(fileURLToPath(import.meta.url))),
    evaluator_version: EVALUATOR_VERSION, reviewer_policy_version: JUDGE_POLICY_VERSION, scenario_catalog_version: reviewed!.manifest.scenario_catalog_version,
    expected_scenarios: expectedIds, expected_records: expected.size, records: logs.length, matching_reviews: report.semantic_reviews.accepted, conversations: groups.size,
    definition_counts: { scenario_turns: cases.reduce((n, item) => n + item.conversations.reduce((n, item) => n + item.turns.length, 0), 0),
      scenario_conversations: cases.reduce((n, item) => n + item.conversations.length, 0), seed_conversations: cases.reduce((n, item) => n + item.history_dates.length, 0) },
    original_100: { scenarios: original.scenarios.length, records: original.totals.turns, counts: counts(original) },
    supplements: { scenarios: supplemental.scenarios.length, records: supplemental.totals.turns, counts: counts(supplemental) },
    engine_api_calls: apiCalls.length, engine_api_errors: apiCalls.filter(item => item.outcome !== 'completed').length,
    parent_files: parents.map(item => ({ directory: item.directory, manifest_sha256: sha(item.manifestRaw), turns_sha256: sha(item.turnsRaw), reviews_sha256: sha(item.reviewsRaw) })),
    run_ids: report.run_ids, no_provider_calls_by_merge: true, scope: reviewed!.manifest.scope };
  for (const [name, value] of [['report', report], ['report-original-100', original], ['report-supplements', supplemental]] as const) {
    await write(name + '.json', encode(value)); await write(name + '.md', renderReport(value));
  }
  await write('manifest.json', encode(manifest)); await write('errors.json', '[]\n');
  const issues = report.scenarios.filter(item => item.status !== 'pass').flatMap(item => ['- ' + item.id + ': ' + item.status,
    ...[...item.failures, ...item.needs_review].slice(0, 8).map(item => '  - ' + item.turn_spec_id + '/' + item.check.id + ': ' + item.check.evidence.slice(0, 400))]);
  await write('SUMMARY.md', ['# Combined frozen-source real evaluation', '', 'Original 100: ' + JSON.stringify(counts(original)) + '; ' + original.totals.turns + ' records.',
    'Supplements SC204/205: ' + JSON.stringify(counts(supplemental)) + '; ' + supplemental.totals.turns + ' records.',
    'Total: ' + logs.length + ' records, ' + report.semantic_reviews.accepted + ' matching reviews, ' + groups.size + ' conversations.',
    'Engine API errors: ' + manifest.engine_api_errors + '. Execution errors: ' + report.totals.execution_errors + ' (' + report.totals.expected_execution_errors + ' expected negatives).',
    'Source manifest SHA-256: ' + manifest.source_manifest_sha256 + '.', '', '## Failures and unresolved issues', '', ...(issues.length ? issues : ['No failed or unresolved recorded checks.']),
    '', '## Limitations', '', manifest.scope, 'Original log/review bytes and run IDs are preserved. Parent directories were read only. This merge made no provider calls. Model judgments are advisory; audio/UI and production behavior remain untested.'].join('\n') + '\n');
  console.log('Merged verified same-source real evidence into ' + output);
  if (report.scenarios.some(item => item.status !== 'pass')) process.exitCode = 1;
}
main().catch(error => { console.error('Merge refused: ' + (error instanceof MergeRejected ? error.message : 'invalid or incomplete evidence') + '. Parent evidence was not changed.'); process.exitCode = 1; });
