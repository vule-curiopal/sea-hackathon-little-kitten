import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildManifest, validateHistory } from '../../backend/fixtures/conversations/history.mjs';

// Only the declared fictional archive is exported. No runtime memories, provider
// responses, environment files, or evaluation results are read by this tool.
const source = new URL('../../backend/fixtures/conversations/generated/', import.meta.url);
const destination = new URL('../src/data/growth-history.json', import.meta.url);
const [manifestText, sessionText] = await Promise.all([
  readFile(new URL('manifest.json', source), 'utf8'),
  readFile(new URL('sessions.jsonl', source), 'utf8'),
]);
const manifest = JSON.parse(manifestText);
const sessions = sessionText.trimEnd().split('\n').map(line => JSON.parse(line));
validateHistory(sessions);
if (JSON.stringify(manifest) !== JSON.stringify(buildManifest(sessions))) {
  throw new Error('The fictional-history manifest differs from its validated sessions.');
}
const history = {
  schemaVersion: 'miu-growth-history-v1',
  provenance: {
    synthetic: true,
    responseOrigin: 'authored_reference',
    source: 'backend/fixtures/conversations/generated/sessions.jsonl',
  },
  profile: {
    id: manifest.persona.profile_id,
    name: manifest.persona.display_name,
    ageAtStart: manifest.persona.age_at_start,
    ageAtEnd: manifest.persona.age_at_end,
    ageBand: manifest.persona.age_band,
  },
  period: {
    start: manifest.period.start,
    end: manifest.period.end,
    days: manifest.period.days,
    timezone: manifest.period.timezone,
  },
  totals: manifest.totals,
  sessions: sessions.map(session => ({
    id: session.session_id,
    date: session.local_date,
    title: session.title,
    age: session.child_age_years,
    language: session.language,
    tags: session.tags,
    messages: session.messages.map(message => ({ id: message.id, role: message.role, content: message.content })),
  })),
};
const output = JSON.stringify(history) + '\n';
if (process.argv.includes('--check')) {
  if (await readFile(destination, 'utf8') !== output) throw new Error('Frontend growth history is stale. Run the growth export tool.');
  console.log(`Growth history matches the source: ${history.totals.sessions} sessions, ${history.totals.messages} messages.`);
} else {
  await mkdir(new URL('../src/data/', import.meta.url), { recursive: true });
  await writeFile(destination, output, 'utf8');
  console.log(`Exported ${history.totals.sessions} fictional sessions to ${fileURLToPath(destination)}.`);
}
