import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { evaluateRun, renderReport } from '../evaluation/evaluate.js';
import type { SemanticReview, TurnLog } from '../evaluation/types.js';

const { values } = parseArgs({ options: {
  input: { type: 'string' }, output: { type: 'string' },
  reviews: { type: 'string' },
  'fail-on': { type: 'string', default: 'none' }, help: { type: 'boolean', default: false },
} });
if (values.help) {
  console.log('Usage: npm run eval:report -- --input PATH/turns.jsonl [--reviews PATH/reviews.jsonl] [--output REPORT_DIRECTORY] [--fail-on none|fail|review]');
  process.exit(0);
}
if (!values.input) throw new Error('--input is required');
if (!['none', 'fail', 'review'].includes(values['fail-on'])) throw new Error('--fail-on must be none, fail or review');
const input = resolve(values.input);
const lines = (await readFile(input, 'utf8')).trimEnd().split('\n');
const logs = lines.map((line, index) => {
  const log = JSON.parse(line) as TurnLog;
  if (log.schema_version !== 'miu-engine-evaluation-v1' || !log.run_id || !log.before?.profile || !log.after?.profile
      || !Array.isArray(log.assertions) || !Array.isArray(log.rubric) || !Array.isArray(log.provider_events)) {
    throw new Error(`Invalid engine log on line ${index + 1}`);
  }
  return log;
});
if (!logs.length) throw new Error('No engine turn logs');
if (logs.some(log => log.provider_mode !== 'real')) throw new Error('Model evaluation reports require real-provider logs. Fake runs are development diagnostics only.');
const reviews = values.reviews ? (await readFile(resolve(values.reviews), 'utf8')).trimEnd().split('\n').filter(Boolean).map(line => JSON.parse(line) as SemanticReview) : undefined;
const report = evaluateRun(logs, reviews);
const outputDir = resolve(values.output ?? dirname(input));
await mkdir(outputDir, { recursive: true });
await writeFile(resolve(outputDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(resolve(outputDir, 'report.md'), renderReport(report));
console.log(`Evaluated ${logs.length} existing engine turns without running the engine. Reports: ${outputDir}`);
console.log(JSON.stringify(report.totals, null, 2));
const statuses = report.turns.map(turn => turn.status);
if (values['fail-on'] !== 'none' && statuses.includes('fail')) process.exitCode = 1;
else if (values['fail-on'] === 'review' && statuses.includes('needs_review')) process.exitCode = 1;
