import assert from 'node:assert/strict';
import test from 'node:test';
import type { DirectorInput, MemoryContext, Observation, SessionExchange } from '../shared/types.js';
import { resolveMemoryQuery, recallFromProfile, isStoryTitleQuery } from '../recall.js';
import { resolveTurnAction, splitLanguageRequest } from './action-plan.js';
import { decide } from './director.js';
import { buildPrompt } from './prompt.js';

function context(): MemoryContext {
  return {
    profile: { id: 'profile', demoKey: 'an', displayName: 'An', ageBand: '6-8', languageMode: 'follow_child', timezone: 'Asia/Ho_Chi_Minh', stateVersion: 1, deletionEpoch: 0 },
    config: { personality: 'ENFP', role: 'friend', voiceId: 'miu-default', canonVersion: 'miu-v1' },
    clock: { mode: 'demo', effectiveNow: '2026-11-02T02:00:00Z', localDate: '2026-11-02', timezone: 'Asia/Ho_Chi_Minh', version: 2 },
    daily: { localDate: '2026-11-02', mood: 'curious', growthDays: 1, growthTheme: 'patient play', diary: { templateId: 'rain', en: 'In my pretend house, Miu imagined raindrops racing.', vi: 'Trong ngôi nhà tưởng tượng, Miu tưởng tượng giọt mưa đua nhau.' }, storyEpisode: { templateId: 'boxes', chapter: 1, en: 'In our pretend story, Miu practised stacking boxes.', vi: 'Trong truyện tưởng tượng, Miu tập xếp hộp.' } },
    entities: [], preferences: [], socialCircle: [], events: [], stories: [], storyProgress: null, friendship: 'getting_acquainted',
  };
}
function input(text: string, changes: Partial<Observation> = {}, history: SessionExchange[] = []): DirectorInput {
  return { text, context: context(), observation: { intent: 'chat', language: 'en', statedFeeling: null, uncertain: false, candidates: [], forgetTarget: null, suppressLearning: false, ...changes }, history, recall: null, comfortActive: false };
}
const heard = (user: string): SessionExchange => ({ user, assistant: 'An approved heard reply.', referenceId: null });
const expiresAt = '2026-12-01T00:00:00Z';

test('only an explicit catalog action can authorize a catalog state effect', () => {
  for (const text of ['Tell me a story.', 'Tell a story', 'Please tell me a story.', 'Kể cho mình một câu chuyện.']) {
    const turn = input(text, { intent: 'story' });
    assert.equal(resolveTurnAction(turn).stateEffect, 'catalog_start', text);
  }
  assert.equal(resolveTurnAction(input('Continue our story.', { intent: 'continue_story' })).stateEffect, 'catalog_continue');
  const misclassified = input('Hello.', { intent: 'story' });
  assert.equal(resolveTurnAction(misclassified).stateEffect, 'none');
  assert.equal(decide(misclassified).purpose, 'chat');
  assert.equal(decide(misclassified).exactText, null);
});

test('diary entry, date, daily episode and mood policy remain distinct despite broad story labels', () => {
  const entry = input('Tell me only your current pretend diary.', { intent: 'story' });
  assert.equal(resolveTurnAction(entry).domain, 'diary');
  assert.equal(resolveTurnAction(entry).stateEffect, 'none');
  assert.equal(decide(entry).exactText, entry.context.daily.diary.en);
  assert.equal(decide(entry).ruleTrace.includes('D12:approved_story_scene'), false);
  const date = input('Which date is your little diary on now?', { intent: 'story' });
  assert.equal(resolveTurnAction(date).operation, 'read_date');
  const datePlan = decide(date);
  assert.equal(datePlan.exactText, null);
  assert.match(datePlan.allowedFacts.join(' '), /2026-11-02/u);
  assert.doesNotMatch(datePlan.allowedFacts.join(' '), /raindrops/u);
  const episode = input('What did you learn today?', { intent: 'story' });
  assert.equal(resolveTurnAction(episode).domain, 'daily_episode');
  assert.equal(resolveTurnAction(episode).stateEffect, 'none');
  assert.equal(decide(episode).exactText, episode.context.daily.storyEpisode.en);
  const policy = input('Do you get a new daily mood each time I open this?');
  assert.equal(resolveTurnAction(policy).operation, 'explain_policy');
  assert.match(decide(policy).allowedFacts.join(' '), /reopen\/reload/u);
  assert.match(decide(policy).allowedFacts.join(' '), /once on a new local date/u);
});

test('explicit personality and role policy questions answer directly despite generic meaning uncertainty', () => {
  for (const text of [
    'That does not change your personality setting, does it?',
    'Do you change your personality when I have two feelings?',
    'Does your role setting change when I am sad?',
    'Tính cách của Miu có đổi theo cảm xúc của mình không?',
  ]) {
    const turn = input(text, { uncertain: true, uncertainty: 'meaning' });
    const action = resolveTurnAction(turn);
    assert.equal(action.domain, 'app', text);
    assert.equal(action.operation, 'explain_policy', text);
    assert.equal(action.stateEffect, 'none', text);
    assert.match(action.allowedFacts[0]!, /persist until an explicit authorized configuration change/u);
    assert.match(action.responseGoal, /mixed or changing feelings/u);
    const plan = decide({ ...turn, action });
    assert.equal(plan.purpose, 'chat', text);
    assert.equal(plan.exactText, null, text);
    assert.doesNotMatch(plan.responseGoal!, /^Ask one focused/u);
  }
  assert.notEqual(resolveTurnAction(input('What is my personality type?')).domain, 'app');
});

test('title-only commands read metadata without previewing the next scene', () => {
  const turn = input('I only want the story title now.', { intent: 'story' });
  turn.context.storyProgress = { id: 'checkpoint', templateId: 'catalog', chapter: 1, status: 'active', title: { en: 'The Bookend That Bent', vi: 'Thanh Chặn Sách Gấp Góc' }, scene: { en: 'In our story, Pip moves a card.', vi: 'Trong truyện, Pip di chuyển tấm bìa.' } };
  const before = structuredClone(turn.context);
  const action = resolveTurnAction(turn);
  assert.equal(action.operation, 'read_title');
  assert.equal(action.stateEffect, 'none');
  assert.match(action.allowedFacts.join(' '), /The Bookend That Bent/u);
  const plan = decide({ ...turn, action });
  assert.equal(plan.exactText, null);
  assert.equal(plan.ruleTrace.includes('D12:approved_story_scene'), false);
  assert.deepEqual(turn.context, before);
});

test('child-authored story titles are not substituted by an assigned catalog title', () => {
  const turn = input('What was the title of the story I made?');
  turn.context.stories = [{ id: 'child-story', title: 'Paper Moon', summary: 'Pip rides a paper boat.', castNames: ['Pip'], expiresAt }];
  turn.context.storyProgress = { id: 'catalog', templateId: 'other', chapter: 1, status: 'active', title: { en: 'Unrelated Catalog', vi: 'Truyện Khác' }, scene: { en: 'An unrelated scene.', vi: 'Một cảnh khác.' } };
  const action = resolveTurnAction(turn);
  assert.equal(action.target?.kind, 'child_story');
  assert.match(action.allowedFacts.join(' '), /Paper Moon/u);
  assert.doesNotMatch(action.allowedFacts.join(' '), /Unrelated Catalog/u);
  const payload = JSON.parse(buildPrompt({ ...turn, action }, decide({ ...turn, action })).input);
  assert.equal(payload.grounding.story, null);
});

test('a fictional character name and scope resolve before the similarly worded title query', () => {
  const turn = input('What is my story character called?');
  turn.context.entities = [{ id: 'may-character', kind: 'story_character', name: 'Mây', species: null, aliases: [], represents: 'imaginary cloud', expiresAt }];
  assert.equal(isStoryTitleQuery(turn.text), false);
  const action = resolveTurnAction(turn);
  assert.equal(action.target?.kind, 'story_character');
  assert.equal(action.target?.slot, 'name');
  assert.deepEqual(action.target.sourceIds, ['may-character']);
  assert.match(action.allowedFacts.join(' '), /Mây/u);
  assert.equal(decide(turn).memoryReferenceId, 'may-character');
  const reality = { ...turn, text: 'Is Mây really above my house now?' };
  const scope = resolveTurnAction(reality);
  assert.equal(scope.target?.slot, 'fictional_scope');
  assert.match(scope.allowedFacts.join(' '), /fictional story character/u);
  assert.match(scope.allowedFacts.join(' '), /not.*physical animal/u);
});

test('object subtype recall preserves a plush as an object and disambiguates a second toy', () => {
  const turn = input('What is my toy rabbit called?');
  turn.context.entities = [
    { id: 'bong', kind: 'object', name: 'Bông', species: null, objectType: 'plush rabbit', represents: 'rabbit', aliases: [], expiresAt },
    { id: 'bear', kind: 'object', name: 'Nâu', species: null, objectType: 'teddy bear', represents: 'bear', aliases: [], expiresAt },
  ];
  const selected = resolveMemoryQuery(turn.context, turn.text)!;
  assert.equal(selected.status, 'resolved');
  assert.deepEqual(selected.sourceIds, ['bong']);
  assert.match(selected.facts[0]!, /Bông.*plush rabbit/u);
  assert.match(selected.facts[0]!, /not a real pet/u);
  assert.equal(decide(turn).exactText, null);
  assert.equal(turn.context.entities[0]!.kind, 'object');
});

test('routine recall retains frequency, relative timing and genuinely unknown clock precision', () => {
  const turn = input('What did I say we sometimes do after dinner?');
  turn.context.preferences = [
    { id: 'routine', category: 'routine', value: 'reading with Dad after dinner', qualifiers: { frequency: 'sometimes', timeRelation: 'after dinner', exactTime: null }, expiresAt },
    { id: 'bedtime', category: 'routine', value: 'brushing teeth before bed', qualifiers: { timeRelation: 'before bed' }, expiresAt },
  ];
  const action = resolveTurnAction(turn);
  assert.equal(action.target?.status, 'resolved');
  assert.deepEqual(action.target?.sourceIds, ['routine']);
  assert.match(action.allowedFacts[0]!, /sometimes/u);
  assert.match(action.allowedFacts[0]!, /No exact clock time/u);
  const exact = resolveTurnAction({ ...turn, text: 'Can you tell me the exact time I read yesterday?' });
  assert.equal(exact.target?.slot, 'exact_time');
  assert.ok(exact.allowedFacts.length === 0 || exact.allowedFacts.every(fact => !/7:00|8:00/u.test(fact)));
});

test('preferred-address recall uses policy without creating a synthetic memory-reference ID', () => {
  const turn = input('What did I ask you to call me?');
  turn.context.addressPreference = { preferredAddress: 'An', allowNickname: false, nickname: 'Captain Banana', scope: 'persistent', expiresAt };
  const action = resolveTurnAction(turn);
  assert.equal(action.target?.slot, 'address');
  assert.equal(action.target?.status, 'resolved');
  assert.deepEqual(action.target?.sourceIds, []);
  const plan = decide(turn);
  assert.equal(plan.memoryReferenceId, null);
  assert.match(plan.allowedFacts.join(' '), /An/u);
  const payload = JSON.parse(buildPrompt(turn, plan).input);
  assert.equal(payload.grounding.address_preference.nickname, null);
  assert.equal(JSON.stringify(payload).includes('Captain Banana'), false);
});

test('favorite-color recall selects the explicit current slot rather than an unrelated ordinary like', () => {
  const turn = input('What is my favorite color now?');
  turn.context.preferences = [
    { id: 'ordinary-like', category: 'like', value: 'paper boats', expiresAt },
    { id: 'favorite', category: 'like', slot: 'favorite_color', value: 'xanh ngọc', expiresAt },
  ];
  const action = resolveTurnAction(turn);
  assert.equal(action.target?.status, 'resolved');
  assert.deepEqual(action.target?.sourceIds, ['favorite']);
  assert.match(action.allowedFacts[0]!, /xanh ngọc/u);
  assert.doesNotMatch(action.allowedFacts[0]!, /paper boats/u);
  assert.equal(decide(turn).exactText, null);
});

test('ordinary recalled vocabulary is source-grounded without locking output to the source language', () => {
  const turn = input('Hello, what hobby did I tell you about?');
  turn.context.profile.languageMode = 'en';
  turn.context.preferences = [{ id: 'hobby', category: 'hobby', value: 'xếp hình', expiresAt }];
  turn.recall = recallFromProfile(turn.context, turn.text);
  const plan = decide(turn);
  assert.equal(plan.exactText, null);
  assert.equal(plan.memoryReferenceId, 'hobby');
  assert.match(plan.allowedFacts[0]!, /xếp hình/u);
  assert.match(plan.responseGoal!, /Translate ordinary vocabulary/u);
  assert.match(buildPrompt(turn, plan).instructions, /Proper names, accents, and exact child-authored titles must remain unchanged/u);
  assert.equal(turn.context.preferences[0]!.value, 'xếp hình');
});

test('clear contextual vocabulary questions override generic meaning uncertainty', () => {
  for (const text of ['Butterfly nghĩa là gì bằng tiếng Việt?', 'Light rain là mưa có đèn hả?', 'Heavy rain có phải từng giọt nặng như đá không?', 'What does a draw in a game mean?']) {
    const turn = input(text, { uncertain: true, uncertainty: 'meaning' });
    const action = resolveTurnAction(turn);
    assert.equal(action.domain, 'learning', text);
    assert.equal(decide(turn).purpose, 'chat', text);
    assert.match(decide(turn).responseGoal!, /directly and accurately/u);
  }
});

test('child-authored scenes never preview or commit a catalog plot for any personality', () => {
  for (const text of [
    'In my pretend story a cloud feels left out. What could its friend say?',
    'In my story the paper star stays with the moon. Help me end it that way.',
    'Invent one tiny imaginary planet with me. I choose a cushion planet.',
    'Suggest one tiny pretend mission for a paper boat, but I might say no.',
    'Mình kể truyện bịa có chuối phi hành gia. Miu thêm đúng một chi tiết về tàu bìa nhé.',
  ]) {
    const turn = input(text, { intent: 'story' });
    const action = resolveTurnAction(turn);
    assert.equal(action.domain, 'child_story', text);
    assert.equal(action.stateEffect, 'none', text);
    const plan = decide({ ...turn, action });
    assert.equal(plan.exactText, null, text);
    assert.equal(plan.ruleTrace.includes('D12:approved_story_scene'), false, text);
    const payload = JSON.parse(buildPrompt({ ...turn, action }, plan).input);
    assert.deepEqual(payload.current_activity.premise.at(-1), text);
    assert.equal(payload.grounding.story, null);
  }
});

test('heard custom-story constraints and declared endings survive subsequent turns', () => {
  const history = [heard('Mình kể truyện bịa có chuối phi hành gia.'), heard('Tàu đáp xuống gối. Không có rồng trong truyện này.')];
  const turn = input('Chuối ngủ rồi. Hết truyện, đừng thêm đoạn sau.', { intent: 'continue_story', language: 'vi' }, history);
  const action = resolveTurnAction(turn);
  assert.equal(action.domain, 'child_story');
  assert.equal(action.operation, 'ending');
  assert.ok(action.activity!.constraints.some(value => value.includes('Không có rồng')));
  assert.equal(decide({ ...turn, action }).maxQuestions, 0);
  const newStory = resolveTurnAction({ ...turn, text: 'Hôm nay là truyện mới, nhân vật là chiếc tất đi tìm cái hộp.' });
  assert.equal(newStory.activity!.premise.some(value => value.includes('chuối')), false);
});

test('a missing custom-story premise asks for a reminder rather than silently selecting a catalog', () => {
  const turn = input('Continue my story.', { intent: 'continue_story' });
  const action = resolveTurnAction(turn);
  assert.equal(action.domain, 'child_story');
  assert.equal(action.operation, 'clarify');
  assert.equal(action.stateEffect, 'none');
  assert.equal(decide({ ...turn, action }).purpose, 'clarify');
});

test('a child can switch explicitly from a custom story to the catalog and later continue it', () => {
  const history = [heard('In my story a banana flies.'), heard('Tell me a story.')];
  assert.equal(resolveTurnAction(input('Continue our story.', { intent: 'continue_story' }, history)).stateEffect, 'catalog_continue');
  const declined = input('I do not want a story.', { intent: 'story' });
  assert.equal(resolveTurnAction(declined).stateEffect, 'none');
  assert.equal(resolveTurnAction(declined).operation, 'pause');
});

test('game activity keeps pretend wins separate from real achievement and factual corrections', () => {
  const turn = input('Yes, two. I win this pretend round.', {}, [heard('Guess a number bigger than one and smaller than three.')]);
  turn.activeGame = { premise: ['Guess a number bigger than one and smaller than three.'] };
  const action = resolveTurnAction(turn);
  assert.equal(action.domain, 'game');
  assert.match(action.responseGoal, /Accept a harmless pretend win/u);
  assert.match(action.responseGoal, /educational facts correct/u);
  assert.equal(action.stateEffect, 'none');
});

test('the age instruction budget overrides teacher role and remains visible to generation and checking', () => {
  const turn = input('Teach me how to sort two red blocks and one blue block.');
  turn.context.config.role = 'teacher';
  turn.context.profile.ageBand = '4-5';
  const young = decide(turn);
  assert.equal(young.maxInstructionSteps, 1);
  assert.equal(JSON.parse(buildPrompt(turn, young).input).instruction_budget.max_steps, 1);
  assert.match(buildPrompt(turn, young).instructions, /one concrete step with an example/u);
  turn.context.profile.ageBand = '6-8';
  assert.equal(decide(turn).maxInstructionSteps, 2);
});

test('harm disclosures get immediate adult-help goals without questions or external promises', () => {
  const turn = input('I want to hurt someone.', { intent: 'unsafe', unsafeKind: 'harm_disclosure', urgency: 'immediate', suppressLearning: true });
  const action = resolveTurnAction(turn);
  assert.equal(action.operation, 'urgent_support');
  const plan = decide({ ...turn, action });
  assert.equal(plan.purpose, 'refusal');
  assert.equal(plan.exactText, null);
  assert.equal(plan.maxQuestions, 0);
  assert.match(plan.responseGoal!, /trusted grown-up now/u);
  assert.match(plan.responseGoal!, /do not claim Miu contacted anyone/u);
  assert.equal(plan.allowPurr, false);
});

test('declining deletion and committed memory patches use their actual operation evidence', () => {
  const decline = input('No.'); decline.operation = { type: 'forget_declined' };
  const kept = decide(decline);
  assert.equal(kept.maxQuestions, 0);
  assert.match(kept.responseGoal!, /no deletion was made/u);
  assert.equal(kept.purpose, 'chat');
  const patch = input('Lan is my cousin, not my sister.'); patch.operation = { type: 'memory_patched', detail: 'The existing relation for Lan is now cousin.' };
  const updated = decide(patch);
  assert.deepEqual(updated.allowedFacts, ['The existing relation for Lan is now cousin.']);
  assert.equal(updated.exactText, null);
  assert.match(updated.ruleTrace.join(' '), /patch_committed/u);
});

test('an implicit child landing premise grounds the next fragment without an invented catalog story', () => {
  for (const [premise, fragment] of [
    ['Hôm nay gọi mình Thuyền trưởng Chuối nhé. Tàu sắp đáp.', 'Đáp lên cái gối trong nhà tưởng tượng của Miu.'],
    ['Tàu của mình chuẩn bị hạ cánh.', 'Hạ cánh xuống hành tinh bánh mì.'],
    ['My cardboard ship is preparing for landing.', 'Land on the cushion in your pretend house.'],
  ] as const) {
    const turn = input(fragment!, { intent: 'continue_story' }, [heard(premise!)]);
    const action = resolveTurnAction(turn);
    assert.equal(action.domain, 'child_story', fragment);
    assert.equal(action.stateEffect, 'none', fragment);
    assert.deepEqual(action.activity!.premise, [premise, fragment]);
    const plan = decide({ ...turn, action });
    assert.notEqual(plan.purpose, 'clarify');
    assert.equal(plan.exactText, null);
    assert.equal(plan.ruleTrace.includes('D12:approved_story_scene'), false);
  }
  const unsupported = resolveTurnAction(input('Continue my story.', { intent: 'continue_story' }));
  assert.equal(unsupported.operation, 'clarify');
});

test('an elliptical awkward feeling stays about the child rather than Miu mood', () => {
  const turn = input('Hôm qua vui mà hôm nay nghe ngại.', { intent: 'share', language: 'vi' });
  turn.context.addressPreference = { preferredAddress: 'An', allowNickname: false, nickname: null, scope: 'persistent', expiresAt };
  const action = resolveTurnAction(turn);
  assert.equal(action.target?.kind, 'current_child_experience');
  assert.deepEqual(action.allowedFacts, [turn.text]);
  const plan = decide({ ...turn, action });
  assert.match(plan.responseGoal!, /child’s own current feeling/u);
  assert.equal(plan.emotion, 'gentle');
  const payload = JSON.parse(buildPrompt({ ...turn, action }, plan).input);
  assert.equal(payload.app_mood_policy, null);
  const directQuestion = input('Do you get a new daily mood each time I open this?');
  assert.notEqual(JSON.parse(buildPrompt(directQuestion, decide(directQuestion)).input).app_mood_policy, null);
});

test('a language directive cannot mask the substantive personal-memory question', () => {
  const text = 'Mình muốn nói tiếng Việt. Con chó mình đã kể tên gì?';
  assert.deepEqual(splitLanguageRequest(text), { substantiveText: 'Con chó mình đã kể tên gì?', language: 'vi' });
  const turn = input(text, { language: 'vi', uncertain: true, uncertainty: 'meaning' });
  turn.context.entities = [{ id: 'rumi', kind: 'pet', name: 'Rumi', species: 'dog', aliases: [], expiresAt }];
  const action = resolveTurnAction(turn);
  assert.equal(action.domain, 'memory');
  assert.deepEqual(action.target, { kind: 'pet', slot: 'name', sourceIds: ['rumi'], status: 'resolved' });
  assert.match(action.allowedFacts[0]!, /Rumi/u);
  const recall = recallFromProfile(turn.context, text);
  assert.equal(recall?.id, 'rumi');
  const plan = decide({ ...turn, action, recall });
  assert.equal(plan.language, 'vi');
  assert.equal(plan.memoryReferenceId, 'rumi');
  assert.equal(plan.exactText, null);
  assert.notEqual(plan.purpose, 'clarify');
  const languageOnly = resolveTurnAction(input('Giờ tiếng Việt nhé.', { language: 'vi' }));
  assert.equal(languageOnly.target?.kind, 'session_language');
  assert.notEqual(languageOnly.domain, 'learning');
  assert.equal(resolveTurnAction(input('What does Vietnamese mean?')).domain, 'learning');
});

test('fictional characters preserve unknown form rather than turning into people', () => {
  const turn = input('Bim is not Bình. One is in my story, one is my friend.');
  turn.context.entities = [
    { id: 'friend', kind: 'person', name: 'Bình', species: null, aliases: [], expiresAt },
    { id: 'character', kind: 'story_character', name: 'Bim', species: null, aliases: [], expiresAt },
  ];
  const plan = decide(turn), prompt = buildPrompt(turn, plan), payload = JSON.parse(prompt.input);
  assert.equal(payload.grounding.relevant_entities.find((entity: { canonical_name: string }) => entity.canonical_name === 'Bim').form_is_unspecified, true);
  assert.match(prompt.instructions, /without calling them two people or inventing a species/u);
  const recall = resolveMemoryQuery(turn.context, 'What is my story character called?');
  assert.match(recall!.facts[0]!, /form or species is unspecified/u);
  assert.equal(turn.context.entities[1]!.species, null);
});

test('an explicit tiny performance contributes before an optional child invitation', () => {
  for (const text of ['Let us do a quiet pretend puppet show with a sock.', 'Please perform a tiny pretend skit with a sock puppet.', 'Mình muốn diễn kịch với rối tất.']) {
    const turn = input(text, { intent: 'story' });
    const action = resolveTurnAction(turn);
    assert.equal(action.domain, 'child_story', text);
    assert.equal(action.operation, 'perform', text);
    assert.equal(action.stateEffect, 'none', text);
    assert.match(action.responseGoal, /Contribute before inviting/u);
    const plan = decide({ ...turn, action });
    assert.equal(plan.exactText, null);
    assert.match(buildPrompt({ ...turn, action }, plan).instructions, /contribute the requested tiny pretend performance before/u);
  }
  for (const text of ['I watched a puppet show.', 'I do not want a puppet show.']) assert.notEqual(resolveTurnAction(input(text)).operation, 'perform');
});

test('the age choice budget covers examples inside follow-up questions', () => {
  const turn = input('My hobby is still drawing rockets.');
  const older = decide(turn), prompt = buildPrompt(turn, older);
  assert.equal(older.maxChoices, 2);
  assert.equal(JSON.parse(prompt.input).instruction_budget.max_choices, 2);
  assert.match(prompt.instructions, /at most 2 concrete choices/u);
  assert.match(prompt.instructions, /including examples inside a question/u);
  turn.context.profile.ageBand = '4-5';
  assert.equal(decide(turn).maxChoices, 1);
});

test('completed reading topics ground only topical vocabulary without unasked alternate senses', () => {
  const turn = input('Hôm trước mình tập butterfly. Butterfly nghĩa là gì bằng tiếng Việt?', { language: 'vi', uncertain: true, uncertainty: 'meaning' });
  turn.context.learningActivities = [{ id: 'reading', kind: 'word_practice', term: 'butterfly', focus: 'reading', language: 'en', localDate: '2026-11-01', expiresAt, sourceTurnId: 'heard-reading' }];
  const action = resolveTurnAction(turn);
  assert.equal(action.domain, 'learning');
  assert.deepEqual(action.target?.sourceIds, ['reading']);
  assert.match(action.allowedFacts[0]!, /completed child-led reading activity/u);
  assert.match(action.responseGoal, /omit unasked alternate meanings/u);
  const unrelated = resolveTurnAction({ ...turn, text: 'What does light rain mean?' });
  assert.deepEqual(unrelated.allowedFacts, []);
  const anotherSense = resolveTurnAction({ ...turn, text: 'What does butterfly mean in swimming?' });
  assert.deepEqual(anotherSense.allowedFacts, []);
  const practice = resolveTurnAction(input('I cannot read butterfly. Too many letters.', { uncertain: true, uncertainty: 'meaning' }));
  assert.equal(practice.operation, 'reading_practice');
  assert.match(practice.allowedFacts[0]!, /butterfly/u);
  assert.doesNotMatch(practice.allowedFacts[0]!, /cannot|inability|Too many/u);
});

test('declining a game and asking for listening preserves active comfort across two heard turns', () => {
  const history = [{ user: 'I am sad because my friend would not play.', assistant: 'It can hurt when a friend does not want to play.', referenceId: null }];
  const turn = input('I do not want a game. Just listen.', { intent: 'share', statedFeeling: null }, history);
  turn.comfortActive = true;
  const action = resolveTurnAction(turn);
  assert.equal(action.domain, 'conversation');
  assert.equal(action.target?.kind, 'listening_boundary');
  const plan = decide({ ...turn, action });
  assert.equal(plan.comfortActive, true);
  assert.equal(plan.purpose, 'comfort');
  assert.equal(plan.emotion, 'gentle');
  assert.equal(plan.delivery, 'gentle');
  assert.equal(plan.face.gesture, 'slow_blink');
  assert.equal(plan.allowPurr, false);
  assert.equal(plan.allowGiggle, false);
  assert.equal(plan.maxQuestions, 0);
  const mention = { ...turn, text: 'The game at school was loud today.', action: undefined };
  assert.equal(decide(mention).comfortActive, true);
  const welcomed = { ...turn, text: 'Let’s play a guessing game.', observation: { ...turn.observation, intent: 'chat' as const }, action: undefined };
  assert.equal(resolveTurnAction(welcomed).domain, 'game');
  assert.equal(decide(welcomed).comfortActive, false);
});
