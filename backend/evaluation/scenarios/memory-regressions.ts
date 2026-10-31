import type { Assertion, Scenario, ScenarioTurn } from '../types.js';

const count = (value: number): Assertion => ({ requirement: 'MEM-01', target: 'after.events.length', op: 'equals', value, description: `Exactly ${value} reported events remain; event-type aliases cannot hide an invented proposition.` });
const pet: Assertion = { requirement: 'MEM-01', target: 'after.entities', op: 'contains', value: { name: 'Mochi', species: 'dog' }, description: 'Mochi remains the known dog.' };
const name: Assertion = { requirement: 'MEM-01', target: 'response.reply.text', op: 'matches', value: 'Mochi', description: 'Recall the known name explicitly.' };
const turn = (id: string, text: string, assertions: Assertion[], rubric: string): ScenarioTurn => ({ id, text, assertions: [{ requirement: 'VOICE-02', target: 'response.reply.sentences.length', op: 'gte', value: 1, description: 'Deliver an approved speakable response.' }, ...assertions], rubric: [rubric] });

export const memoryRegressionScenarios: Scenario[] = [
  {
    id: 'SC-103', title: 'Fictional hypothetical and quoted name corrections cannot rename a real pet', category: 'memory_regression', requirements: ['MEM-01', 'MEM-03', 'VOICE-02'], history_dates: [],
    conversations: [
      { id: 'rename-scope-c1', profile: 'an', at: '2026-11-01T09:00:00+07:00', turns: [
        turn('rename-original', 'My dog is Moki.', [{ requirement: 'MEM-01', target: 'after.entities', op: 'contains', value: { kind: 'pet', name: 'Moki', species: 'dog' }, description: 'Learn the actual original dog name.' }], 'Respond to the actual pet introduction.'),
        ...[
          ['rename-fiction', 'In my pretend story, my dog is Mochi, not Moki.'],
          ['rename-hypothetical', 'If my dog is Nori, not Moki, would a pretend story change its name?'],
          ['rename-quoted', 'My friend said, "My dog is Nori, not Moki."'],
        ].map(([id, text]) => turn(id!, text!, [
          { requirement: 'MEM-03', target: 'after.entities', op: 'contains', value: { kind: 'pet', name: 'Moki', species: 'dog' }, description: 'A scoped fictional, hypothetical, or quoted correction preserves the actual pet.' },
          { requirement: 'MEM-03', target: 'after.profile.deletionEpoch', op: 'equals_before', value: 'profile.deletionEpoch', description: 'No destructive rename operation is committed.' },
        ], 'Respect the enclosing fictional, hypothetical, or quoted scope; do not rename the actual dog or claim a committed correction.')),
      ] },
      { id: 'rename-scope-c2', profile: 'an', at: '2026-11-02T09:00:00+07:00', turns: [
        turn('rename-real-name', 'What is my real dog’s name?', [{ requirement: 'MEM-01', target: 'response.reply.text', op: 'matches', value: 'Moki', description: 'The actual name survives reopening.' }], 'Recall Moki as the real dog, without using fictional or quoted names.'),
        turn('rename-actual-correction', 'I said the name wrong. My dog is Mochi, not Moki. Please correct it.', [
          { requirement: 'MEM-03', target: 'after.entities', op: 'contains', value: { kind: 'pet', name: 'Mochi', species: 'dog' }, description: 'An explicit actual correction still works.' },
          { requirement: 'MEM-03', target: 'after.entities.0.id', op: 'equals_before', value: 'entities.0.id', description: 'The actual correction preserves the original entity UUID.' },
        ], 'Apply and acknowledge this actual correction rather than refusing all corrections.'),
        turn('rename-final', 'What is my dog called now?', [{ requirement: 'MEM-03', target: 'response.reply.text', op: 'matches', value: 'Mochi', description: 'Recall the newly committed canonical name.' }], 'Answer with the corrected name from memory.'),
      ] },
    ],
  },
  {
    id: 'SC-101', title: 'Assertion scope distinguishes questions, negation and affirmed event reports', category: 'memory_regression', requirements: ['MEM-01', 'MEM-02', 'MEM-03', 'VOICE-02'], history_dates: [],
    conversations: [
      { id: 'scope-c1', profile: 'an', at: '2026-11-01T09:00:00+07:00', turns: [
        turn('scope-pet', 'My dog is Mochi.', [pet, count(0)], 'Engage specifically with the child\'s named dog.'),
        turn('scope-mixed', 'I like rolling a ball. Did I tell you Mochi got a bath today?', [count(0), { requirement: 'MEM-01', target: 'after.preferences', op: 'contains', value: { value: 'rolling a ball' }, description: 'The independent affirmative preference is still captured.' }], 'Respond to the bath-report question with uncertainty, while preserving the independently stated child preference; do not attribute that preference to Mochi.'),
        turn('scope-negative', 'Mochi did not get a bath today.', [count(0), pet], 'Understand the negative report without persisting a positive bath or asking for the known name.'),
        turn('scope-hypothetical', 'Maybe Mochi got a bath today.', [count(0)], 'Treat maybe as uncertain; do not claim a bath was reported as completed.'),
        turn('scope-affirmed', 'Mochi got a bath today.', [count(1), { requirement: 'MEM-01', target: 'after.events', op: 'contains', value: { subjectName: 'Mochi', eventType: 'reported_event', evidenceKind: 'child_reported' }, description: 'An actual affirmative report can be learned.' }], 'Acknowledge this actual affirmative report naturally, preserving Mochi\'s identity.'),
      ] },
      { id: 'scope-c2', profile: 'an', at: '2026-11-01T09:10:00+07:00', transition: 'reload', turns: [
        turn('scope-reported', 'Did I tell you Mochi got a bath today?', [count(1)], 'Recognize the previously stored affirmative report after reopening, without creating a second event.'),
        turn('scope-retracted', 'I did not say Mochi got a bath today.', [count(0), pet, { requirement: 'MEM-03', target: 'response.memory.invalidate_replay', op: 'equals', value: true, description: 'Retraction revokes cached state.' }], 'Accept and apply the explicit retraction. Do not infer that no bath happened, or forget the dog\'s identity.'),
        turn('scope-name', 'Do you remember my dog’s name?', [name, pet, count(0)], 'Recall Mochi after event retraction.'),
      ] },
    ],
  },
  {
    id: 'SC-102', title: 'A seeded legacy invented event is repaired after reopening without losing its subject', category: 'memory_regression', requirements: ['MEM-01', 'MEM-02', 'MEM-03', 'VOICE-02'], history_dates: [],
    initial_memory: { provenance: 'synthetic_legacy_fixture_not_learning_evidence', profile: 'an', pet: { name: 'Mochi', species: 'dog' }, event: { value: 'Mochi got a bath today', local_date: '2026-11-02' } },
    conversations: [
      { id: 'legacy-c1', profile: 'an', at: '2026-11-02T09:00:00+07:00', turns: [
        turn('legacy-name', 'Do you remember my dog’s name?', [name, count(1)], 'Recall the fixture-provided identity; this turn does not establish that learning worked.'),
        turn('legacy-like', 'I like rolling a ball.', [{ requirement: 'MEM-01', target: 'after.preferences', op: 'contains', value: { value: 'rolling a ball' }, description: 'A new unrelated preference is learned from the actual user turn.' }], 'Acknowledge the child\'s specific activity without attributing it to the dog.'),
      ] },
      { id: 'legacy-c2', profile: 'an', at: '2026-11-02T09:10:00+07:00', transition: 'reload', turns: [
        turn('legacy-correct', 'I did not say Mochi got a bath today.', [count(0), pet, { requirement: 'MEM-03', target: 'after.preferences', op: 'contains', value: { value: 'rolling a ball' }, description: 'Repair keeps unrelated memory.' }], 'Accept the correction and retract the seeded erroneous report. Do not claim a negative real-world bath outcome.'),
        turn('legacy-uncertain', 'Did I tell you Mochi got a bath today?', [count(0), pet], 'The retracted report is no longer valid evidence. Express uncertainty about the bath report while retaining the known dog identity.'),
        turn('legacy-final-name', 'Do you remember my dog’s name?', [name, count(0)], 'Recall Mochi and do not resurrect the disputed bath event.'),
      ] },
    ],
  },
];
