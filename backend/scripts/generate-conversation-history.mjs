import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest, flattenMessages, generateHistory, validateHistory } from '../fixtures/conversations/history.mjs';
import { buildEvaluationCases } from '../fixtures/conversations/evaluation.mjs';

const args = process.argv.slice(2);
const check = args.includes('--check');
const positional = args.filter(arg => arg !== '--check');
if (positional.length > 1 || positional.some(arg => arg.startsWith('--'))) {
  throw new Error('Usage: node backend/scripts/generate-conversation-history.mjs [output-directory] [--check]');
}
const destination = resolve(positional[0] ?? fileURLToPath(new URL('../fixtures/conversations/generated/', import.meta.url)));
const sessions = generateHistory();
validateHistory(sessions);
const manifest = buildManifest(sessions);
const jsonLines = values => `${values.map(value => JSON.stringify(value)).join('\n')}\n`;
const outputs = {
  'sessions.jsonl': jsonLines(sessions),
  'messages.jsonl': jsonLines(flattenMessages(sessions)),
  'manifest.json': `${JSON.stringify(manifest, null, 2)}\n`,
  'evaluation-cases.json': `${JSON.stringify(buildEvaluationCases(sessions), null, 2)}\n`,
};
for (const [name, content] of Object.entries(outputs)) {
  const path = resolve(destination, name);
  if (check) {
    if (await readFile(path, 'utf8') !== content) throw new Error(`${path} is stale; regenerate the conversation history.`);
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
}
console.log(`${check ? 'Verified' : 'Generated'} ${manifest.totals.sessions} sessions, ${manifest.totals.exchanges} exchanges, ${manifest.totals.messages} messages (${manifest.period.start} through ${manifest.period.end}) at ${destination}`);
