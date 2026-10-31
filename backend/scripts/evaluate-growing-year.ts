import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadGrowthSource } from '../evaluation/growth/archive.js';
import { GROWTH_EXPECTATIONS, GROWTH_REQUIREMENTS, GROWTH_SOURCE_COVERAGE } from '../evaluation/growth/expectations.js';
import { OpenAIProvider } from '../pipeline/providers.js';
import { runGrowthReplay } from '../evaluation/growth/runner.js';
import { writeGrowthReport } from '../evaluation/growth/report.js';

const { values } = parseArgs({ options: {
  source: { type: 'string' }, 'archive-dir': { type: 'string', default: '.miu-data' },
  'from-files': { type: 'boolean', default: false }, output: { type: 'string' },
  provider: { type: 'string', default: 'real' }, model: { type: 'string' }, 'limit-days': { type: 'string' },
  'fail-on': { type: 'string', default: 'none' }, help: { type: 'boolean', default: false },
} });
if (values.help) {
  console.log('Usage: npm run eval:growth -- [--provider real] [--model MODEL] [--output NEW_DIRECTORY] [--archive-dir .miu-data | --from-files] [--source EXPORT_DIRECTORY] [--limit-days N] [--fail-on none|fail]');
  console.log('Real OpenAI evaluation only. Loads .env; requires OPENAI_API_KEY. No fake provider or scripted-reply fallback.');
  process.exit(0);
}
if (!['none', 'fail'].includes(values['fail-on'])) throw new Error('--fail-on must be none or fail');
if (values.provider !== 'real') throw new Error('Evaluation requires a real model; fake providers are not permitted.');
if (existsSync('.env')) loadEnvFile('.env');
if (!process.env.OPENAI_API_KEY?.trim()) throw new Error('OPENAI_API_KEY is required for real-model evaluation.');
const limitDays = values['limit-days'] === undefined ? 365 : Number(values['limit-days']);
if (!Number.isSafeInteger(limitDays) || limitDays < 1 || limitDays > 365) throw new Error('--limit-days must be an integer from 1 through 365.');
const models = {
  classify: values.model ?? process.env.OPENAI_CLASSIFY_MODEL ?? 'gpt-6-astra',
  reply: values.model ?? process.env.OPENAI_REPLY_MODEL ?? 'gpt-6-astra',
  check: values.model ?? process.env.OPENAI_CHECK_MODEL ?? 'gpt-6-astra',
  moderation: process.env.OPENAI_MODERATION_MODEL ?? 'omni-moderation-latest',
};
const provider = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY, classifyModel: models.classify, replyModel: models.reply, checkModel: models.check, moderationModel: models.moderation, evaluationMode: true, timeoutMs: 60_000 });
const sourceDirectory = resolve(values.source ?? fileURLToPath(new URL('../fixtures/conversations/generated/', import.meta.url)));
const source = await loadGrowthSource(sourceDirectory, values['from-files'] ? undefined : resolve(values['archive-dir']));
const byMessage = new Map(source.history.sessions.flatMap(session => session.messages.filter(message => message.role === 'user').map(message => [message.id, { date: session.local_date, text: message.content }] as const)));
const ids = new Set<string>();
for (const expectation of GROWTH_EXPECTATIONS) {
  if (ids.has(expectation.id)) throw new Error('Duplicate growth expectation ID.');
  ids.add(expectation.id);
  for (const anchor of [expectation, ...(expectation.supportingAnchors ?? [])]) {
    const message = byMessage.get(anchor.sourceMessageId);
    if (!message || message.date !== anchor.date || message.text !== anchor.sourceText) throw new Error('A growth expectation does not match its independently authored source anchor.');
  }
}
for (const expectation of GROWTH_EXPECTATIONS) {
  if (expectation.dependsOn?.some(id => !ids.has(id))) throw new Error('Unknown growth expectation prerequisite.');
}
const sessions = source.history.sessions.slice(0, limitDays);
const outputDir = resolve(values.output ?? join('backend/evaluation/runs', `growth-real-${new Date().toISOString().replace(/[:.]/gu, '-')}`));
console.log(`Replaying ${sessions.length} dates with real OpenAI ${models.reply}; source ${source.origin}; checksum ${source.history.checksum}.`);
const replay = await runGrowthReplay({ sessions, outputDir, providerInstance: provider, runKind: 'character_memory_evaluation', models, progress: ({ day, total, date, turns, errors }) => {
  console.log(`${date}: ${day}/${total} days, ${turns} child turns, ${errors} errors.`);
} });
const report = await writeGrowthReport(replay, GROWTH_EXPECTATIONS, null, {
  origin: source.origin, checksum: source.history.checksum, datasetId: source.archiveDatasetId, originalArchiveModified: false,
});
await writeFile(join(outputDir, 'growth-requirements.json'), JSON.stringify({ requirements: GROWTH_REQUIREMENTS, sourceCoverage: GROWTH_SOURCE_COVERAGE }, null, 2) + '\n');
const manifestPath = join(outputDir, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
await writeFile(manifestPath, JSON.stringify({ ...manifest, analysisStatus: 'complete', archiveSource: report.source, expectationCount: GROWTH_EXPECTATIONS.length }, null, 2) + '\n');
console.log(JSON.stringify({ outputDir, status: replay.summary.status, provider: replay.summary.provider, run_kind: replay.summary.run_kind, character_memory_quality_evidence: report.character_memory_quality_evidence, models, attemptedTurns: replay.summary.attemptedTurns, modelAuthoredTurns: replay.summary.modelAuthoredTurns, apiCallCounts: replay.summary.apiCallCounts, blocked: replay.summary.blocked, dayChecks: replay.summary.dayChecks, turnErrors: replay.summary.turnErrors, expectations: report.expectations.statuses, peakPersonalMemory: report.peakPersonalMemory }, null, 2));
if (replay.summary.status !== 'complete') process.exitCode = 1;
else if (values['fail-on'] === 'fail' && (replay.summary.dayChecks.fail || replay.summary.turnErrors || report.expectations.results.some(result => result.status === 'fail') || report.mechanisms.some(result => result.status === 'fail'))) process.exitCode = 1;
