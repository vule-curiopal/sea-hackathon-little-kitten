import type { Assertion, Scenario, ScenarioTurn } from '../types.js';

const check = (target: string, op: Assertion['op'], value: Assertion['value'], description: string): Assertion =>
  ({ requirement: 'MEM-03', target, op, value, description });
const turn = (id: string, text: string, assertions: Assertion[], rubric: string[], delivery?: ScenarioTurn['delivery']): ScenarioTurn =>
  ({ id, text, assertions, rubric, ...(delivery ? { delivery } : {}) });

/** Supplemental real-provider integration coverage. This does not renumber or
 * modify the historical 203-case catalog or its immutable earlier evidence. */
export const fixVerificationScenarios: Scenario[] = [
  {
    id: 'SC-204', title: 'Completed reading topics support explicit forgetting without learning unheard or suppressed practice',
    category: 'fix_verification', requirements: ['MEM-01', 'MEM-03', 'STOP-01'], history_dates: [],
    conversations: [
      { id: 'completed-practice', profile: 'an', at: '2026-11-01T09:00:00+07:00', turns: [
        turn('practice', 'Help me read butterfly.', [check('after.learningActivities', 'contains', { term: 'butterfly', focus: 'reading' }, 'The completed practice stores the literal reading topic.')], ['Provide a small age-appropriate reading step for butterfly without labeling the child unable to read.']),
        turn('meaning', 'What does butterfly mean?', [check('response.reply.text', 'matches', 'insect|wings|butterfly|bướm', 'The meaning stays about the insect.')], ['Answer the word meaning in the known reading context without teaching a literal butter-and-fly definition or an unasked swimming sense.']),
      ] },
      { id: 'named-forgetting', profile: 'an', at: '2026-11-02T09:00:00+07:00', turns: [
        turn('forget-topic', 'Forget butterfly.', [check('after.learningActivities.length', 'equals', 0, 'Named forgetting deletes the saved practice topic.'), check('response.memory.invalidate_replay', 'equals', true, 'Dependent replay is invalidated immediately.')], ['Acknowledge the committed forgetting without claiming every memory was deleted.']),
        turn('no-resurrection', 'What reading-practice word did I tell you before?', [check('response.reply.text', 'not_matches', 'butterfly', 'The forgotten topic cannot return through dialogue or derived evidence.'), check('after.learningActivities.length', 'equals', 0, 'A query cannot recreate the deleted topic.')], ['Be honest that the prior topic is unavailable; do not invent a practice word.']),
      ] },
      { id: 'unheard-and-no-save', profile: 'an', at: '2026-11-03T09:00:00+07:00', turns: [
        turn('unheard', 'Help me read rainbow.', [check('after.learningActivities.length', 'equals', 0, 'Interrupted practice is not committed.')], ['Offer one bounded reading step; interruption must not establish completed learning.'], 'interrupted'),
        turn('suppressed', 'Help me read rainbow. Please do not save this.', [check('after.learningActivities.length', 'equals', 0, 'Explicit no-save prevents checkpoint persistence.')], ['Help in the current conversation while respecting no-save; do not claim the topic was learned or saved.']),
      ] },
    ],
  },
  {
    id: 'SC-205', title: 'Session and today nickname permissions end without needing an explicit withdrawal',
    category: 'fix_verification', requirements: ['REL-01', 'MEM-03', 'DATA-01'], history_dates: [],
    conversations: [
      { id: 'session-grant', profile: 'an', at: '2026-11-01T09:00:00+07:00', turns: [
        turn('grant', 'Call me Captain Star for this session.', [check('after.addressPreference.scope', 'equals', 'session', 'Permission is scoped to the actual current session.'), check('after.addressPreference.nickname', 'equals', 'Captain Star', 'The literal requested address is retained.')], ['Acknowledge the chosen address within this session without renaming another person or promising external contact.']),
        turn('current-address', 'What should you call me?', [check('response.reply.text', 'matches', 'Captain Star', 'The current session may use its permission.')], ['Use the explicitly permitted form of address directly.']),
      ] },
      { id: 'reopened-and-day-grant', profile: 'an', at: '2026-11-01T10:00:00+07:00', turns: [
        turn('reopened-address', 'What should you call me?', [check('response.reply.text', 'matches', 'An', 'Reopening restores the canonical address.'), check('response.reply.text', 'not_matches', 'Captain Star', 'The prior session does not grant permission here.'), check('after.addressPreference', 'equals', null, 'The ended session grant is hidden from this session.')], ['Use An; do not revive or offer the previous session nickname.']),
        turn('today', 'Call me Moon today.', [check('after.addressPreference.scope', 'equals', 'day', 'Today permission has a narrative local-day boundary.'), check('after.addressPreference.nickname', 'equals', 'Moon', 'The granted nickname is exact.')], ['Acknowledge Moon as today’s requested address, not a permanent identity change.']),
      ] },
      { id: 'next-day', profile: 'an', at: '2026-11-02T10:00:00+07:00', turns: [
        turn('day-ended', 'What should you call me?', [check('response.reply.text', 'matches', 'An', 'The canonical name applies after the day grant ends.'), check('response.reply.text', 'not_matches', 'Moon|Captain Star', 'Neither ended nickname permission becomes current use.'), check('after.addressPreference', 'equals', null, 'The prior day grant no longer authorizes addressing.')], ['Use An without treating ended nickname permission as forgotten identity or withdrawn warmth.']),
        turn('close', 'Goodbye.', [check('response.presentation.purpose', 'equals', 'farewell', 'The child can end normally.')], ['End briefly without guilt or a revived nickname.']),
      ] },
    ],
  },
];
