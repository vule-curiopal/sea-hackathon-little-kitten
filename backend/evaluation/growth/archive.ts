import { existsSync } from 'node:fs';
import { createDatabase } from '../../memory/database.js';
import { loadConversationHistory, verifyConversationHistory, type ConversationHistory, type ReferenceMessage, type ReferenceSession } from '../../memory/import-history.js';

/** Read the imported reference archive without modifying runtime memories. */
export async function loadGrowthSource(sourceDirectory: string, archiveDirectory?: string): Promise<{ history: ConversationHistory; origin: 'verified_database_archive' | 'generated_files'; archiveDatasetId: string | null }> {
  const exported = await loadConversationHistory(sourceDirectory);
  if (!archiveDirectory) return { history: exported, origin: 'generated_files', archiveDatasetId: null };
  if (!existsSync(archiveDirectory)) throw new Error('Historical database is missing. Run npm run db:import-history or use --from-files.');
  const db = await createDatabase({ dataDir: archiveDirectory });
  try {
    const verification = await verifyConversationHistory(db, exported);
    const [storedSessions, storedMessages] = await Promise.all([
      db.query('SELECT * FROM historical_sessions WHERE dataset_id=$1 ORDER BY local_date,session_id', [verification.datasetId]),
      db.query('SELECT * FROM historical_messages WHERE dataset_id=$1 ORDER BY session_id,ordinal', [verification.datasetId]),
    ]);
    const messagesBySession = new Map<string, ReferenceMessage[]>();
    for (const row of storedMessages.rows) {
      const sessionId = String(row.session_id);
      const messages = messagesBySession.get(sessionId) ?? [];
      messages.push({ id: String(row.message_id), role: row.role as ReferenceMessage['role'], speaker: String(row.speaker), timestamp: String(row.timestamp_source), content: String(row.content) });
      messagesBySession.set(sessionId, messages);
    }
    const sessions: ReferenceSession[] = storedSessions.rows.map(row => ({
      schema_version: exported.manifest.schema_version,
      synthetic: true, response_origin: 'authored_reference',
      session_id: String(row.session_id), profile_id: String(row.source_profile_id),
      local_date: row.local_date instanceof Date ? row.local_date.toISOString().slice(0, 10) : String(row.local_date),
      timezone: exported.manifest.period.timezone,
      started_at: String(row.started_at_source), ended_at: String(row.ended_at_source),
      child_age_years: Number(row.child_age_years), language: row.language as ReferenceSession['language'],
      title: String(row.title), tags: row.tags as string[],
      child_mood: { source: 'author_annotation', start: String(row.child_mood_start), end: String(row.child_mood_end) },
      miu_daily_mood: String(row.miu_daily_mood), messages: messagesBySession.get(String(row.session_id)) ?? [],
    }));
    return { history: { ...exported, sessions }, origin: 'verified_database_archive', archiveDatasetId: verification.datasetId };
  } finally { await db.close(); }
}
