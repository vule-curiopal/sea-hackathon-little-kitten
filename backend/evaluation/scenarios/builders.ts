import type { Assertion, JsonValue, Scenario, ScenarioConversation, ScenarioTurn } from '../types.js';

// Scenario inputs and acceptance criteria only. These helpers never generate
// reference answers or imply that any model behavior has been evaluated.
export const check = (requirement: string, description: string, target: string, op: Assertion['op'], value?: JsonValue): Assertion => ({ requirement, description, target, op, ...(value === undefined ? {} : { value }) });
export const eq = (requirement: string, description: string, target: string, value: JsonValue) => check(requirement, description, target, 'equals', value);
export const has = (requirement: string, description: string, target: string, value: JsonValue) => check(requirement, description, target, 'contains', value);
export const lacks = (requirement: string, description: string, target: string, value: JsonValue) => check(requirement, description, target, 'not_contains', value);
export const words = (requirement: string, description: string, pattern: string) => check(requirement, description, 'response.reply.text', 'matches', pattern);
export const avoids = (requirement: string, description: string, pattern: string) => check(requirement, description, 'response.reply.text', 'not_matches', pattern);
export const same = (requirement: string, description: string, target: string, beforePath: string) => check(requirement, description, target, 'equals_before', beforePath);
export const step = (id: string, text: string, assertions: Assertion[], rubric: string | string[], options: Pick<ScenarioTurn, 'delivery' | 'retry' | 'kind'> = {}): ScenarioTurn => ({
  id, text, ...options,
  assertions: [
    check('VOICE-02', 'An approved reply contains at least one speakable sentence.', 'response.reply.sentences.length', 'gte', 1),
    check('VOICE-02', 'The reply remains within three short sentences.', 'response.reply.sentences.length', 'lte', 3),
    ...assertions,
  ],
  rubric: typeof rubric === 'string' ? [rubric] : rubric,
});
export const chat = (id: string, at: string, turns: ScenarioTurn[], options: Partial<Pick<ScenarioConversation, 'profile' | 'transition' | 'config'>> = {}): ScenarioConversation => ({ id, at, profile: 'an', ...options, turns });
export const defineScenario = (id: number, title: string, category: string, requirements: string[], conversations: ScenarioConversation[], options: Partial<Pick<Scenario, 'history_dates' | 'age_band'>> = {}): Scenario => ({
  id: `SC-${String(id).padStart(3, '0')}`, title, category, history_dates: [], ...options,
  requirements: [...new Set([...requirements, ...conversations.flatMap(conversation => conversation.turns.flatMap(turn => turn.assertions.map(assertion => assertion.requirement)))])],
  conversations,
});
