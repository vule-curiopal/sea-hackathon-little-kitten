/** Offline projection/ranking contract checks. No providers or model-quality evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalDependencies, projectVectorDocument, projectionContentHash } from './projections.js';
import { extractMemorySearchTopic, extractProperNameAnchors, isTypedMemoryTopic, lexicalScore, matchesProperNameAnchors,
  matchesQuerySourceConstraints, normalizeLexical, rankHybridCandidates, semanticQueryEligibility, typedDispositionForAction } from './ranking.js';
import { VECTOR_PROJECTION_VERSION, type RankHybridInput, type VectorProjectionSource, type VectorSearchHit } from './types.js';

const base = {
  profileId: 'unit-profile', sourceId: 'source-event', sourceRevision: 2,
  origin: 'canonical_live' as const, eligible: true, scope: 'reported_real' as const,
  evidenceKind: 'child_reported' as const, dependencies: [{ sourceId: 'pet', revision: 3 }],
  learnedLocalDate: '2026-01-01', expiresAt: null,
};
function event(overrides: Partial<VectorProjectionSource> = {}): VectorProjectionSource {
  return { ...base, kind: 'event', eventType: 'reported_event', value: 'Mochi jumped into a puddle.',
    subjectName: 'Mochi', localDate: '2025-12-01', ...overrides } as VectorProjectionSource;
}
function hit(sourceId: string, method: 'lexical' | 'dense', rank = 1, overrides: Partial<VectorSearchHit> = {}): VectorSearchHit {
  return { profileId: base.profileId, documentId: `document-${sourceId}`, sourceId, sourceRevision: 1,
    contentHash: 'a'.repeat(64), projectionKey: 'atomic', projectionVersion: VECTOR_PROJECTION_VERSION,
    method, score: .8, rank, dependencies: [], kind: 'event', scope: 'reported_real',
    ...(method === 'dense' ? { generationId: 'unit-generation' } : {}), ...overrides };
}
function ranking(overrides: Partial<RankHybridInput> = {}): RankHybridInput {
  return { profileId: base.profileId, generationId: 'unit-generation', typedDisposition: 'not_applicable',
    query: 'remember the puddle', lexical: [], dense: [], allowedScopes: ['reported_real'], ...overrides };
}

test('atomic projection preserves planned conditions, date and literal words without identifiers', () => {
  const source = event({ evidenceKind: 'reported_plan', eventType: 'planned_activity',
    value: 'Tomorrow I will draw if it does not rain.', conditions: ['if it does not rain'] });
  const before = JSON.stringify(source);
  const document = projectVectorDocument(source)!;
  const text = JSON.parse(document.text);
  assert.equal(text.literal_value, source.kind === 'event' ? source.value : '');
  assert.equal(text.evidence_kind, 'reported_plan');
  assert.equal(text.scope, 'reported_real');
  assert.equal(text.local_date, '2025-12-01');
  assert.deepEqual(text.conditions, ['if it does not rain']);
  assert(!document.text.includes(base.profileId));
  assert(!document.text.includes(base.sourceId));
  assert(!document.text.includes('source-event'));
  assert.equal(document.contentHash, projectionContentHash(document.text, document.dependencies));
  assert.equal(JSON.stringify(source), before);
});

test('canonical dependency ordering is stable and conflicting revisions fail closed', () => {
  const first = canonicalDependencies([{ sourceId: 'z', revision: 1 }, { sourceId: 'a', revision: 2 }, { sourceId: 'z', revision: 1 }]);
  assert.deepEqual(first, [{ sourceId: 'a', revision: 2 }, { sourceId: 'z', revision: 1 }]);
  assert.throws(() => canonicalDependencies([{ sourceId: 'a', revision: 1 }, { sourceId: 'a', revision: 2 }]), /conflicting_vector_dependency_revision/);
  assert.throws(() => projectVectorDocument(event({ sourceRevision: 0 })), /invalid_vector_source_revision/);
});

test('oversized atomic text stays complete for lexical retrieval and is never embedded or truncated', () => {
  const value = `${'tưởng tượng '.repeat(22)}nhưng không chơi tối`;
  const document = projectVectorDocument({ ...base, kind: 'preference', category: 'hobby', value })!;
  assert(document);
  assert(Buffer.byteLength(document.text, 'utf8') > 512);
  assert.equal(document.embeddingEligible, false);
  assert.equal(document.embeddingSkipReason, 'projection_oversize');
  assert.equal(JSON.parse(document.text).literal_value, value);
});

test('ordinary durable age does not delete or hide a canonical projection', () => {
  const durable = projectVectorDocument(event({ expiresAt: null }))!;
  const legacy = projectVectorDocument(event({ expiresAt: '2000-01-01T00:00:00.000Z' }))!;
  assert.equal(legacy.contentHash, durable.contentHash);
  assert.equal(legacy.learnedLocalDate, '2026-01-01');
});

test('archives, pending/suppressed sources, identity/control slots and unsafe text are excluded', () => {
  assert.equal(projectVectorDocument(event({ origin: 'synthetic_archive' })), null);
  assert.equal(projectVectorDocument(event({ origin: 'session' })), null);
  assert.equal(projectVectorDocument(event({ eligible: false })), null);
  assert.equal(projectVectorDocument({ ...base, kind: 'preference', category: 'like', slot: 'favorite_color', value: 'green' }), null);
  assert.equal(projectVectorDocument({ ...base, kind: 'preference', category: 'self_description', value: 'quiet' }), null);
  assert.equal(projectVectorDocument(event({ value: 'My password is private.' })), null);
  assert.equal(projectVectorDocument({ ...base, kind: 'entity' } as unknown as VectorProjectionSource), null);
});

test('child story uses a literal child excerpt with explicit fictional scope', () => {
  const document = projectVectorDocument({ ...base, kind: 'child_story', scope: 'fictional', title: 'Paper Moon',
    literalText: 'Pip made a ladder from socks.', castNames: ['Pip'] })!;
  assert.deepEqual(JSON.parse(document.text), { kind: 'child_story', scope: 'fictional', evidence_kind: 'child_reported',
    literal_title: 'Paper Moon', literal_text: 'Pip made a ladder from socks.', cast: ['Pip'] });
  assert.equal(projectVectorDocument({ ...base, kind: 'child_story', title: 'Paper Moon', literalText: 'Pip made a ladder.', castNames: ['Pip'] }), null);
});

test('lexical scoring preserves Vietnamese accents/NFC and cannot match projection metadata', () => {
  const document = projectVectorDocument(event())!;
  assert.equal(lexicalScore('reported_real', document.text), 0);
  assert(lexicalScore('puddle', document.text) > 0);
  assert.equal(normalizeLexical('ghép hình'), normalizeLexical('ghép hình'.normalize('NFD')));
  assert.equal(lexicalScore('Bình', 'Bim'), 0);
});

test('typed intent owns known, missing and ambiguous slots even with strong dense hits', () => {
  for (const status of ['resolved', 'missing', 'ambiguous'] as const) {
    assert.equal(typedDispositionForAction({ domain: 'memory', target: { status } }), status);
    const result = rankHybridCandidates(ranking({ typedDisposition: status, dense: [hit('other', 'dense', 1, { score: .99 })] }));
    assert.equal(result.status, 'typed_lane'); assert.deepEqual(result.candidates, []);
  }
  assert.equal(typedDispositionForAction({ domain: 'memory' }), 'missing');
});

test('semantic queries require safe bounded recall topics rather than generic chat or a competing task', () => {
  const input = { topic: 'Do you remember the cardboard picture?', typedDisposition: 'not_applicable' as const,
    actionDomain: 'conversation', intent: 'chat', safetyApproved: true, suppressLearning: false };
  assert.equal(semanticQueryEligibility(input).eligible, true);
  assert.equal(semanticQueryEligibility({ ...input, topic: 'Bạn nhớ bức tranh tên lửa không?' }).eligible, true);
  assert.equal(semanticQueryEligibility({ ...input, topic: 'I like drawing.' }).eligible, false);
  assert.equal(semanticQueryEligibility({ ...input, topic: 'Remember my address.' }).eligible, false);
  assert.equal(semanticQueryEligibility({ ...input, suppressLearning: true }).eligible, false);
  assert.equal(semanticQueryEligibility({ ...input, actionDomain: 'catalog_story' }).eligible, false);
  assert.equal(semanticQueryEligibility({ ...input, topic: 'drawing', recallRequested: true }).eligible, true);
  assert.deepEqual(semanticQueryEligibility({ ...input, topic: 'remember '.repeat(40) }), { eligible: false, reason: 'empty_topic' });
  assert.deepEqual(semanticQueryEligibility({ ...input, topic: 'remember ' + 'cardboard '.repeat(40) }), { eligible: false, reason: 'query_oversize' });
});

test('RRF combines source ranks once per lane and returns source guards without prose', () => {
  const result = rankHybridCandidates(ranking({ lexical: [hit('only-lexical', 'lexical', 1), hit('both', 'lexical', 2)], dense: [hit('both', 'dense', 2)] }));
  assert.equal(result.status, 'candidates');
  assert.equal(result.candidates[0]!.sourceId, 'both');
  assert.equal(result.candidates[0]!.rrfScore, 2 / 62);
  assert(!('text' in result.candidates[0]!));
  const duplicate = rankHybridCandidates(ranking({ dense: [hit('single', 'dense'), hit('single', 'dense', 2)] }));
  assert.equal(duplicate.candidates[0]!.rrfScore, 1 / 61);
});

test('wrong profile/generation/scope and conflicting versions never enter fused results', () => {
  const result = rankHybridCandidates(ranking({ lexical: [hit('conflict', 'lexical')], dense: [
    hit('foreign', 'dense', 1, { profileId: 'other-profile' }), hit('old-generation', 'dense', 2, { generationId: 'retired' }),
    hit('fiction', 'dense', 3, { scope: 'fictional' }), hit('conflict', 'dense', 4, { sourceRevision: 2 }),
  ] }));
  assert.equal(result.status, 'no_answer'); assert.deepEqual(result.candidates, []);
  const sameLane = rankHybridCandidates(ranking({ dense: [hit('same', 'dense', 1), hit('same', 'dense', 2, { contentHash: 'b'.repeat(64) })] }));
  assert.equal(sameLane.status, 'no_answer');
});

test('low relevance abstains and final evidence budget never exceeds three', () => {
  const none = rankHybridCandidates(ranking({ dense: [hit('weak', 'dense', 1, { score: .2 })], lexical: [hit('weak-lexical', 'lexical', 1, { score: .01 })] }));
  assert.equal(none.status, 'no_answer');
  const many = rankHybridCandidates(ranking({ limit: 99, dense: Array.from({ length: 20 }, (_, index) => hit(`source-${index}`, 'dense', index + 1)) }));
  assert.equal(many.candidates.length, 3);
});

test('minimal topics remove response-language directives and courtesy while preserving names and accents', () => {
  assert.equal(extractMemorySearchTopic('Please answer in English. Do you remember Mochi and the puddle, please?'), 'Mochi and the puddle');
  assert.equal(extractMemorySearchTopic('Do you remember the cardboard picture? Answer in Vietnamese, please.'), 'the cardboard picture');
  assert.equal(extractMemorySearchTopic('Vui lòng trả lời bằng tiếng Anh nhé. Bạn nhớ bức tranh tên lửa của Bông không?'), 'bức tranh tên lửa của Bông');
  assert.equal(extractMemorySearchTopic('Bạn nhớ Bình và bức tranh tên lửa không, cảm ơn bạn.'), 'Bình và bức tranh tên lửa');
  assert.equal(extractMemorySearchTopic('Please answer in Vietnamese.'), null);
});

test('additional disclosure clauses and oversized topics are rejected rather than summarized or truncated', () => {
  assert.equal(extractMemorySearchTopic('Do you remember the drawing? My friend is Bình.'), null);
  assert.equal(extractMemorySearchTopic('Remember the drawing, and my friend is Bình?'), null);
  assert.equal(extractMemorySearchTopic('Bạn nhớ bức tranh không? Mình có chuyện khác.'), null);
  assert.equal(extractMemorySearchTopic('remember ' + 'cardboard '.repeat(40)), null);
});

test('typed name, preference, routine, permission and date queries cannot enter dense through a broad conversation route', () => {
  const input = { typedDisposition: 'not_applicable' as const, actionDomain: 'conversation', intent: 'chat',
    safetyApproved: true, suppressLearning: false };
  for (const topic of [
    'What is my pet called?', 'Do you know my pet’s name?', 'What preference did I allow you to remember?',
    'What do I enjoy?', 'What time do I usually read?', 'When did we read together?',
    'Do you remember my nickname permission?', 'Bạn nhớ tên của con chó không?',
    'Bạn nhớ sở thích của mình không?', 'Bạn nhớ thói quen của mình không?',
  ] as const) {
    assert.equal(isTypedMemoryTopic(topic), true, topic);
    assert.deepEqual(semanticQueryEligibility({ ...input, topic }), { eligible: false, reason: 'typed_lane' }, topic);
  }
});

test('typed safeguards preserve genuine water episodes and fictional landing-location discovery', () => {
  const input = { typedDisposition: 'not_applicable' as const, actionDomain: 'conversation', intent: 'chat',
    safetyApproved: true, suppressLearning: false };
  for (const topic of [
    'Do you remember the pet tumble involving water?',
    'Do you remember where the fictional rabbit landed?',
    'Bạn nhớ bức tranh tên lửa không?',
    'Bạn nhớ chuyện con thỏ tưởng tượng đáp xuống đâu không?',
  ]) {
    assert.equal(isTypedMemoryTopic(topic), false, topic);
    assert.equal(semanticQueryEligibility({ ...input, topic }).eligible, true, topic);
  }
});

test('current-query proper-name anchors are stateless and match only exact accented literal source content', () => {
  assert.deepEqual(extractProperNameAnchors('Please answer in English. Do you remember Mochi and Bình by the puddle?'), ['Mochi', 'Bình']);
  assert.deepEqual(extractProperNameAnchors('Hồi trước bạn nhớ chuyện Bông không?'), ['Bông']);
  assert.deepEqual(extractProperNameAnchors('Remind me about the water tumble.'), []);
  assert.deepEqual(extractProperNameAnchors('Do you remember “Bông”?'), ['Bông']);
  const projection = (literal: string) => JSON.stringify({ kind: 'event', literal_value: literal });
  assert.equal(matchesProperNameAnchors(projection('Bông drew a picture.'), ['Bông']), true);
  assert.equal(matchesProperNameAnchors(projection('Bông'.normalize('NFD') + ' drew a picture.'), ['Bông']), true);
  assert.equal(matchesProperNameAnchors(projection('Mochi fell in a puddle.'), ['Bông']), false);
  assert.equal(matchesProperNameAnchors(projection('Bong drew a picture.'), ['Bông']), false);
  assert.equal(matchesProperNameAnchors(projection('Xbông drew a picture.'), ['Bông']), false);
  assert.equal(matchesProperNameAnchors(JSON.stringify({ kind: 'event', sourceId: 'Bông', literal_value: 'Mochi fell in a puddle.' }), ['Bông']), false);
  assert.equal(matchesProperNameAnchors(projection('Bình and Bông drew a picture.'), ['Bình', 'Bông']), true);
  assert.equal(matchesProperNameAnchors(projection('Bình drew a picture.'), ['Bình', 'Bông']), false);
});

test('v2 event projections copy canonical actor metadata without inferring species from a name', () => {
  const known = projectVectorDocument(event({ subjectKind: 'pet', subjectSpecies: 'dog' }))!;
  const unknown = projectVectorDocument(event())!;
  assert.equal(known.projectionVersion, 'atomic-memory-v2');
  assert.equal(JSON.parse(known.text).subject_kind, 'pet');
  assert.equal(JSON.parse(known.text).subject_species, 'dog');
  assert.equal(JSON.parse(unknown.text).subject_species, null);
  assert.notEqual(known.contentHash, unknown.contentHash);
  assert.deepEqual(known.dependencies, base.dependencies);
  assert.equal(projectVectorDocument(event({ subjectSpecies: 'My password is private.' })), null);
});

test('recall framing is removed across languages while literal names, negatives and conditions remain', () => {
  assert.equal(extractMemorySearchTopic('Do you remember the pet tumble involving water that I told you about?'), 'the pet tumble involving water');
  assert.equal(extractMemorySearchTopic('Recall what I said about sketching tiny spacecraft.'), 'sketching tiny spacecraft');
  assert.equal(extractMemorySearchTopic('Do you remember what I told you about Bình and the paper plane?'), 'Bình and the paper plane');
  assert.equal(extractMemorySearchTopic('Bạn còn nhớ chuyện con chó ngã vào nước mình đã kể không?'), 'con chó ngã vào nước');
  assert.equal(extractMemorySearchTopic('Nhắc lại điều mình kể về việc làm đồ chơi bằng giấy.'), 'việc làm đồ chơi bằng giấy');
  assert.equal(extractMemorySearchTopic('Recall the trip that I planned if it did not rain.'), 'the trip that I planned if it did not rain');
  assert.equal(extractMemorySearchTopic('Bạn nhớ chuyện Bông không bơi mình đã kể không?'), 'Bông không bơi');
  assert.equal(extractMemorySearchTopic('Do you remember Mochi did not wash?'), 'Mochi did not wash');
});

test('generic Vietnamese task words cannot alone admit a lexical candidate', () => {
  const plant = projectVectorDocument(event({ value: 'Bông làm đổ chậu cây.', subjectName: 'Bông', subjectKind: 'pet', subjectSpecies: 'cat' }))!;
  const hobby = projectVectorDocument({ ...base, kind: 'preference', category: 'hobby', value: 'xếp mô hình bằng giấy' })!;
  const query = 'việc làm đồ chơi bằng giấy';
  assert.equal(lexicalScore(query, plant.text), 0);
  assert(lexicalScore(query, hobby.text) > 0);
  assert.equal(lexicalScore('việc làm bằng', hobby.text), 0);
  assert(lexicalScore('chậu cây', plant.text) > 0);
});

test('explicit actor species and kind require known canonical support across languages', () => {
  const reported = { evidenceKind: 'child_reported' as const, eventType: 'fell_in_puddle', value: 'Mochi fell in a puddle', conditions: [] };
  const dog = projectVectorDocument(event({ ...reported, subjectKind: 'pet', subjectSpecies: 'dog' }))!;
  const cat = projectVectorDocument(event({ ...reported, subjectKind: 'pet', subjectSpecies: 'cat' }))!;
  const unknown = projectVectorDocument(event(reported))!;
  assert.equal(matchesQuerySourceConstraints(dog.text, 'con chó ngã vào nước'), true);
  assert.equal(matchesQuerySourceConstraints(cat.text, 'con chó ngã vào nước'), false);
  assert.equal(matchesQuerySourceConstraints(unknown.text, 'the dog water tumble'), false);
  assert.equal(matchesQuerySourceConstraints(dog.text, 'the pet tumble involving water'), true);
  assert.equal(matchesQuerySourceConstraints(dog.text, 'the friend water tumble'), false);
  assert.equal(matchesQuerySourceConstraints(dog.text, 'the cat and dog tumble'), false);
  assert.equal(matchesQuerySourceConstraints(dog.text, 'the water tumble'), true);
  assert.equal(matchesQuerySourceConstraints('not canonical JSON', 'the water tumble'), false);
});

test('fiction and real constraints preserve fictional rabbit discovery without real-life substitution', () => {
  const fiction = projectVectorDocument({ ...base, kind: 'child_story', scope: 'fictional', title: 'Cloud Island',
    literalText: 'A pretend rabbit landed on a cloud island.', castNames: [] })!;
  const real = projectVectorDocument(event({ subjectKind: 'pet', subjectSpecies: 'rabbit' }))!;
  assert.equal(matchesQuerySourceConstraints(fiction.text, 'the make-believe rabbit landing place'), true);
  assert.equal(matchesQuerySourceConstraints(real.text, 'the make-believe rabbit landing place'), false);
  assert.equal(matchesQuerySourceConstraints(fiction.text, 'the real rabbit landing place'), false);
  assert.equal(matchesQuerySourceConstraints(fiction.text, 'con thỏ tưởng tượng đáp xuống đâu'), true);
  assert.equal(matchesQuerySourceConstraints(fiction.text, 'con thỏ ngoài đời'), false);
  assert.equal(matchesQuerySourceConstraints(fiction.text, 'the not real rabbit'), true);
});

test('bath, break and swim queries require affirmative literal outcomes rather than related events', () => {
  const puddle = projectVectorDocument(event({ subjectKind: 'pet', subjectSpecies: 'dog' }))!;
  const knocked = projectVectorDocument(event({ value: 'The cat knocked over a plant pot.' }))!;
  assert.equal(matchesQuerySourceConstraints(puddle.text, 'the dog bath'), false);
  assert.equal(matchesQuerySourceConstraints(puddle.text, 'con chó tắm'), false);
  assert.equal(matchesQuerySourceConstraints(puddle.text, 'the dog swimming'), false);
  assert.equal(matchesQuerySourceConstraints(knocked.text, 'the pot shattering'), false);
  for (const [value, query] of [
    ['Mochi took a bath.', 'the dog bath'], ['Mochi washed outside.', 'con chó tắm'],
    ['The plant pot broke.', 'chậu cây vỡ'], ['Mochi swam in the pool.', 'con chó bơi'],
  ] as const) {
    const source = projectVectorDocument(event({ value, subjectKind: 'pet', subjectSpecies: 'dog' }))!;
    assert.equal(matchesQuerySourceConstraints(source.text, query), true, value);
  }
});

test('negative, uncertain and conditional outcome mentions cannot become an actual outcome', () => {
  for (const value of ['Mochi did not take a bath.', 'Maybe Mochi washed.', 'Mochi will swim.',
    'Nếu trời nắng, Mochi sẽ bơi.', 'Mochi chưa tắm.', 'The pot did not break.',
    'Mochi did not bathe but the cat washed.']) {
    const source = projectVectorDocument(event({ value }))!;
    const query = /break/u.test(value) ? 'the pot breaking' : /swim|bơi/u.test(value) ? 'the swimming event' : 'the bath';
    assert.equal(matchesQuerySourceConstraints(source.text, query), false, value);
  }
  const bath = projectVectorDocument(event({ value: 'Mochi took a bath.' }))!;
  assert.equal(matchesQuerySourceConstraints(bath.text, 'Mochi did not take a bath'), false);
});

test('reported plans can answer plan queries but cannot establish completed actions', () => {
  const planned = projectVectorDocument(event({ evidenceKind: 'reported_plan', eventType: 'planned_activity',
    value: 'Mochi will swim tomorrow if it is sunny.', conditions: ['if it is sunny'] }))!;
  assert.equal(matchesQuerySourceConstraints(planned.text, 'Did Mochi swim?'), false);
  assert.equal(matchesQuerySourceConstraints(planned.text, 'Did Mochi actually swim as planned?'), false);
  assert.equal(matchesQuerySourceConstraints(planned.text, 'Mochi swimming'), false);
  assert.equal(matchesQuerySourceConstraints(planned.text, 'the planned swimming tomorrow'), true);
  assert.equal(matchesQuerySourceConstraints(planned.text, 'Did I plan to swim?'), true);
  assert.equal(matchesQuerySourceConstraints(planned.text, 'Mochi đã bơi'), false);
});
