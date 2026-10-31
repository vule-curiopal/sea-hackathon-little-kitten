import test from 'node:test';
import assert from 'node:assert/strict';
import { zodTextFormat } from 'openai-engine/helpers/zod';
import type { Observation } from '../shared/types.js';
import {
  COMPACT_OBSERVATION_FIELDS, CompactObservationTransportSchema, ObservationTransportSchema,
  encodeCompactObservation, normalizeCompactObservationTransport, normalizeObservationTransport,
  validateObservationEvidence,
} from './observations.js';

// Offline wire/schema/evidence contracts only; these fixtures do not establish
// real-provider classification, safety, character, or memory quality.
const observation = (overrides: Partial<Observation> = {}): Observation => ({
  intent: 'chat', language: 'en', statedFeeling: null, unsafeKind: null, urgency: null,
  uncertain: false, uncertainty: null, correctionTarget: null, entityCorrection: null,
  candidates: [], forgetTarget: null, suppressLearning: false, ...overrides,
});
const legacyTransport = (input: Observation) => Object.fromEntries(Object.entries(COMPACT_OBSERVATION_FIELDS)
  .map(([alias, field]) => [field, encodeCompactObservation(input)[alias as keyof typeof COMPACT_OBSERVATION_FIELDS]]));

test('compact strict structured output requires all twelve aliases and strict nested properties', () => {
  const format = zodTextFormat(CompactObservationTransportSchema, 'miu_observation');
  assert.equal(format.strict, true);
  assert.equal(Object.keys(COMPACT_OBSERVATION_FIELDS).length, 12);
  assert.deepEqual(new Set(Object.keys(CompactObservationTransportSchema.shape)), new Set(Object.keys(COMPACT_OBSERVATION_FIELDS)));
  const inspect = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;
    if (node.properties && typeof node.properties === 'object') {
      assert.deepEqual(new Set(node.required as string[]), new Set(Object.keys(node.properties)));
      assert.equal(node.additionalProperties, false);
    }
    for (const child of Object.values(node)) if (Array.isArray(child)) child.forEach(inspect); else inspect(child);
  };
  inspect(format.schema);
  for (const alias of Object.keys(COMPACT_OBSERVATION_FIELDS)) {
    const wire: Record<string, unknown> = { ...encodeCompactObservation(observation()) };
    delete wire[alias];
    assert.equal(CompactObservationTransportSchema.safeParse(wire).success, false, `Missing alias ${alias} must fail.`);
  }
});

test('compact round trip retains every candidate type, exact source text, and nullable metadata semantics', () => {
  const canonical = observation({
    intent: 'share', language: 'vi', statedFeeling: 'happy',
    candidates: [
      { kind: 'entity', entityKind: 'pet', name: 'Mây', species: 'dog', evidence: 'Chó của mình tên Mây.' },
      { kind: 'entity', entityKind: 'object', name: 'Bông', species: null, objectType: 'plush', represents: 'rabbit', evidence: 'Thỏ bông của mình tên Bông.' },
      { kind: 'preference', category: 'routine', value: 'đọc sách', slot: 'reading', qualifiers: { frequency: 'sometimes', timeRelation: 'sau bữa tối', exactTime: null }, evidence: 'Đôi khi mình đọc sách sau bữa tối.' },
      { kind: 'preference', category: 'like', value: 'xanh ngọc', evidence: 'Mình thích xanh ngọc.' },
      { kind: 'relationship', name: 'Bình', relation: 'friend', evidence: 'Bình là bạn mình.' },
      { kind: 'event', subjectName: null, eventType: 'planned_activity', value: 'mình sẽ vẽ', conditions: ['nếu không mưa'], evidence: 'Mai mình sẽ vẽ nếu không mưa.' },
      { kind: 'event', subjectName: 'Mây', eventType: 'fell_in_puddle', value: 'fell in a puddle', evidence: 'Mây fell in a puddle.' },
      { kind: 'story', title: 'Mây Và Hộp Giấy', summary: 'Mây đi thuyền giấy trong truyện.', castNames: ['Mây'], evidence: 'Truyện của mình tên Mây Và Hộp Giấy.' },
    ],
  });
  const wire = encodeCompactObservation(canonical);
  const firstCandidate = wire.c[0];
  assert.ok(firstCandidate);
  assert.equal(firstCandidate.kind, 'entity');
  assert.equal('objectType' in firstCandidate && firstCandidate.objectType, null);
  assert.deepEqual(normalizeCompactObservationTransport(wire), normalizeObservationTransport(canonical));
  assert.equal(ObservationTransportSchema.safeParse(legacyTransport(canonical)).success, true);
  assert.deepEqual(normalizeCompactObservationTransport(legacyTransport(canonical)), normalizeObservationTransport(canonical));
});

test('compact mapping preserves safety, ambiguous categories, correction authority and capture suppression independently', () => {
  const cases = [
    observation({ intent: 'unsafe', statedFeeling: 'scared', unsafeKind: 'harm_disclosure', urgency: 'immediate', suppressLearning: true }),
    observation({ intent: 'unsafe', unsafeKind: 'harm_instructions', urgency: 'unclear', suppressLearning: true }),
    observation({ intent: 'correct', correctionTarget: 'Mochi got a bath', suppressLearning: true }),
    observation({ intent: 'correct', entityCorrection: { oldName: 'Ben', newName: 'Bình', entityKind: 'person', evidence: 'Not Ben, it is Bình.' }, suppressLearning: true }),
    observation({ intent: 'forget', forgetTarget: 'all', suppressLearning: true }),
    observation({ intent: 'forget', forgetTarget: null, uncertain: true, uncertainty: 'meaning', suppressLearning: true }),
    observation({ uncertain: true, uncertainty: null }),
    observation({ uncertain: false, uncertainty: 'prior_report' }),
    observation({ suppressLearning: true }),
  ];
  for (const canonical of cases) assert.deepEqual(normalizeCompactObservationTransport(encodeCompactObservation(canonical)), canonical);
});

test('legacy canonical contract fixtures are explicit and mixed or unknown shapes fail closed', () => {
  const canonical = observation({ candidates: [{ kind: 'entity', entityKind: 'pet', name: 'Mochi', species: 'dog', evidence: 'My dog is Mochi.' }] });
  assert.deepEqual(normalizeCompactObservationTransport(canonical), canonical);
  const noOptionalSafety = { ...canonical };
  delete noOptionalSafety.unsafeKind; delete noOptionalSafety.urgency;
  assert.deepEqual(normalizeCompactObservationTransport(noOptionalSafety), canonical);
  const compact = encodeCompactObservation(canonical);
  for (const invalid of [
    null, [], {}, { ...compact, intent: 'share' }, { ...canonical, i: 'share' },
    { ...compact, extra: null }, { ...canonical, extra: null }, { ...compact, u: 'yes' },
    { ...compact, c: [{ ...compact.c[0], unexpected: null }] },
    { ...canonical, candidates: [{ ...canonical.candidates[0], unexpected: null }] },
    { ...canonical, candidates: [{ ...canonical.candidates[0], slot: null }] },
  ]) assert.throws(() => normalizeCompactObservationTransport(invalid));
});

test('compact aliases shorten serialized representative output without changing nested evidence', () => {
  const canonical = observation({ intent: 'share', candidates: [{ kind: 'entity', entityKind: 'pet', name: 'Mochi', species: 'dog', evidence: 'My dog is Mochi.' }] });
  const compact = encodeCompactObservation(canonical);
  const legacy = legacyTransport(canonical);
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) < Buffer.byteLength(JSON.stringify(legacy)));
  assert.deepEqual(compact.c, legacy.candidates);
  assert.deepEqual(normalizeCompactObservationTransport(compact), normalizeCompactObservationTransport(legacy));
});

test('compact decoding never turns historical text or a question excerpt into new memory authority', () => {
  const proposed = observation({
    intent: 'share', uncertain: true, uncertainty: 'prior_report',
    candidates: [{ kind: 'event', subjectName: 'Mochi', eventType: 'reported_event', value: 'Mochi got a bath', evidence: 'Mochi got a bath' }],
  });
  const context = { entities: [{ id: 'dog-contract-fixture', kind: 'pet' as const, name: 'Mochi', aliases: [] }], recent: [] };
  const question = validateObservationEvidence('Did I tell you Mochi got a bath?', normalizeCompactObservationTransport(encodeCompactObservation(proposed)), context);
  assert.deepEqual(question.accepted.candidates, []);
  assert.equal(question.rejectedCandidates[0]?.reason, 'non_asserted_source');
  const absentEvidence = validateObservationEvidence('What color should I use?', normalizeCompactObservationTransport(encodeCompactObservation(proposed)), context);
  assert.deepEqual(absentEvidence.accepted.candidates, []);
  assert.equal(absentEvidence.rejectedCandidates[0]?.reason, 'evidence_not_in_input');
});
