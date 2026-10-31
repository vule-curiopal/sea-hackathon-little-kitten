import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { scenarios, validateScenarios } from '../evaluation/catalog.js';
import { runEvaluation } from '../evaluation/runner.js';

const { values } = parseArgs({ options: {
  provider: { type: 'string', default: 'real' }, history: { type: 'string', default: 'none' },
  output: { type: 'string' }, scenario: { type: 'string', multiple: true }, limit: { type: 'string' },
  'fail-on': { type: 'string', default: 'none' }, help: { type: 'boolean', default: false },
} });
if (values.help) {
  console.log('Usage: npm run eval:run -- [--provider real] [--history full|none] [--output NEW_DIRECTORY] [--scenario SC-001] [--limit N] [--fail-on none|fail|review]');
  process.exit(0);
}
if (values.provider !== 'real') throw new Error('Evaluation requires --provider real; fake providers are not model evaluations.');
if (existsSync('.env')) loadEnvFile('.env');
if (!['full', 'none'].includes(values.history)) throw new Error('--history must be full or none');
if (!['none', 'fail', 'review'].includes(values['fail-on'])) throw new Error('--fail-on must be none, fail or review');
validateScenarios(scenarios);
let selected = values.scenario ? scenarios.filter(scenario => values.scenario!.includes(scenario.id)) : scenarios;
if (values.scenario?.some(id => !scenarios.some(scenario => scenario.id === id))) throw new Error('Unknown scenario ID');
if (values.limit !== undefined) {
  const limit = Number(values.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > scenarios.length) throw new Error(`--limit must be an integer from 1 to ${scenarios.length}`);
  selected = selected.slice(0, limit);
}
if (!selected.length) throw new Error('No scenarios selected');
const defaultParent = resolve('backend/evaluation/runs');
const outputDir = values.output ? resolve(values.output) : resolve(defaultParent, `${new Date().toISOString().replace(/[:.]/gu, '-')}-${values.provider}`);
await mkdir(resolve(outputDir, '..'), { recursive: true });
const result = await runEvaluation({
  scenarios: selected, provider: values.provider as 'fake' | 'real', history: values.history as 'full' | 'none', outputDir,
  progress: message => console.log(message),
});
console.log(`Saved ${result.logCount} actual engine turn records to ${result.outputDir}`);
console.log(JSON.stringify(result.report.totals, null, 2));
const statuses = result.report.turns.map(turn => turn.status);
if (result.blocked) process.exitCode = 1;
else if (values['fail-on'] !== 'none' && statuses.includes('fail')) process.exitCode = 1;
else if (values['fail-on'] === 'review' && statuses.includes('needs_review')) process.exitCode = 1;
