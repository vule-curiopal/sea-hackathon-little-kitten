import { createHash } from 'node:crypto';
import type { TurnLog } from './types.js';

export function reviewKey(log: TurnLog): string {
  return [log.run_id, log.phase, log.scenario_id ?? 'history', log.conversation_id, log.turn_spec_id].join('/');
}
export function reviewEvidenceHash(log: TurnLog): string {
  // Full immutable evidence binds reviews to the exact engine run, input, reply,
  // delivery and state snapshots. A changed reply or assertion invalidates a review.
  return createHash('sha256').update(JSON.stringify(log)).digest('hex');
}
