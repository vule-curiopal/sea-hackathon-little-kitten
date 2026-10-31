import type { TurnLog } from './types.js';

/** Keep seed warm-ups separate even if they reuse a test conversation identifier. */
export function groupJudgeConversations(logs: TurnLog[], includeSeeds = false): Map<string, TurnLog[]> {
  const groups = new Map<string, TurnLog[]>();
  for (const log of logs) {
    if (log.phase !== 'scenario' && !(includeSeeds && log.phase === 'scenario_history')) continue;
    const key = `${log.run_id}/${log.phase}/${log.scenario_id}/${log.conversation_id}`;
    groups.set(key, [...(groups.get(key) ?? []), log]);
  }
  return groups;
}

/** Prior child context is scoped to the same isolated run, scenario, and profile. */
export function selectJudgePriorContext(logs: TurnLog[], conversation: TurnLog[]): TurnLog[] {
  const first = conversation[0];
  if (!first) return [];
  if (conversation.some(log => log.phase !== first.phase || log.run_id !== first.run_id || log.scenario_id !== first.scenario_id
    || log.conversation_id !== first.conversation_id || log.profile_key !== first.profile_key)) {
    throw new Error('Semantic review context requires one conversation and one fictional profile.');
  }
  const start = logs.indexOf(first);
  if (start < 0) throw new Error('Conversation is not present in the ordered engine log.');
  return logs.slice(0, start).filter(log => log.run_id === first.run_id
    && log.scenario_id === first.scenario_id && log.profile_key === first.profile_key);
}
