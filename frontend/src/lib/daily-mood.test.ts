import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationMood, createDailyMood, dailyEnergy, emotionLevel, localDay, moodFeelings, moodPresentation, restoreDailyMood, spokenMoodText } from './daily-mood.ts';
import { activityEmotion, createIdleRoutine, presentedActivity } from './miu-behavior.ts';
import { emotions, getMiuPose } from './miu-pose.ts';

const daily = createDailyMood('an', '2026-10-31');

test('all fifteen feelings have visible low and high strength differences in the artwork', () => {
  const visible = ['ry', 'mouthScaleX', 'mouthScaleY', 'mouthLine', 'mouthFill', 'armL', 'armR', 'browL', 'blush', 'openL', 'fillOp', 'pupil', 'question', 'sparkle', 'zzz', 'tear', 'puff'] as const;
  for (const emotion of emotions) {
    const low = getMiuPose(emotion, undefined, undefined, .2);
    const high = getMiuPose(emotion, undefined, undefined, .9);
    assert.ok(visible.filter(key => low[key] !== high[key]).length >= 3, emotion);
    for (const pose of [low, high]) assert.ok(Object.values(pose).every(value => typeof value !== 'number' || Number.isFinite(value)));
  }
  assert.equal(getMiuPose('happy', undefined, undefined, .2).openL, 1);
  assert.equal(getMiuPose('happy', undefined, undefined, .9).happyL, 1);
  assert.equal(getMiuPose('sad', undefined, undefined, .2).tear, 0);
  assert.ok(getMiuPose('sad', undefined, undefined, .9).tear > 0);
  assert.ok(getMiuPose('sulky', undefined, undefined, .9).puff > getMiuPose('sulky', undefined, undefined, .2).puff * 2);
});

test('visual intensity keeps sleeping eyes closed and preserves direct gesture reach', () => {
  assert.equal(getMiuPose('sleepy', undefined, undefined, .2).openL, 1);
  for (const activity of ['sleep', 'doze', 'stretch', 'wake'] as const) {
    const low = getMiuPose('sleepy', activity, undefined, .2);
    assert.equal(low.closed, 1, activity);
    assert.equal(low.openL, 0, activity);
  }
  for (const activity of ['highfive', 'groom', 'cuddle', 'play'] as const) {
    assert.equal(getMiuPose('happy', activity, undefined, .2).armR, getMiuPose('happy', activity, undefined, .9).armR, activity);
  }
});

test('one fictional daily mood survives reload, with bounded independent emotion levels', () => {
  assert.deepEqual(restoreDailyMood('an', daily.date, JSON.stringify(daily)), daily);
  assert.deepEqual(createDailyMood('an', daily.date), daily);
  for (const feeling of moodFeelings) assert.ok(daily.levels[feeling] >= 0 && daily.levels[feeling] <= 100);
});

test('daily rollover and profile changes are isolated, using the local calendar date', () => {
  const tomorrow = restoreDailyMood('an', '2026-11-01', JSON.stringify(daily));
  const other = restoreDailyMood('binh', daily.date, JSON.stringify(daily));
  assert.equal(tomorrow.date, '2026-11-01');
  assert.notDeepEqual(tomorrow.levels, daily.levels);
  assert.equal(other.profile, 'binh');
  assert.notDeepEqual(other.levels, daily.levels);
  assert.equal(localDay(new Date(2026, 9, 31, 23, 59)), '2026-10-31');
  assert.equal(localDay(new Date(2026, 10, 1, 0, 0)), '2026-11-01');
});

test('corrupt, missing, or invalid stored mood data cannot produce invalid poses', () => {
  for (const stored of [null, '{broken', 'null', JSON.stringify({ ...daily, levels: { ...daily.levels, happy: 500 } }), JSON.stringify({ ...daily, levels: { ...daily.levels, sad: 'sad' } })]) {
    assert.deepEqual(restoreDailyMood('an', daily.date, stored), daily);
  }
});

test('conversation changes the current feeling, and its strength still depends on today', () => {
  const quiet = { ...daily, levels: { ...daily.levels, happy: 25 } };
  const bright = { ...daily, levels: { ...daily.levels, happy: 90 } };
  const low = conversationMood(quiet, 'A happy adventure', 'happy');
  const high = conversationMood(bright, 'A happy adventure', 'happy');
  assert.equal(low.emotion, 'happy');
  assert.equal(high.emotion, 'happy');
  assert.ok(high.intensity > low.intensity);
  assert.ok(conversationMood(daily, 'I am very excited!').intensity > conversationMood(daily, 'A little happy').intensity);
  assert.equal(conversationMood(daily, 'Why do clouds float?').emotion, 'curious');
  assert.equal(conversationMood(daily, 'Miu ơi, ôm Miu một cái').emotion, 'love');
});

test('expressed sadness overrides a cheerful daily mood and keeps presentation gentle', () => {
  const bright = { ...daily, levels: { ...daily.levels, happy: 94 }, feeling: 'happy' as const };
  for (const words of ["I'm really sad", 'I feel scared', 'Hôm nay mình rất buồn', 'Con cảm thấy lo lắng']) {
    const turn = conversationMood(bright, words, 'happy');
    assert.equal(turn.comfort, true);
    assert.equal(turn.emotion, 'sad');
    assert.ok(turn.intensity <= .72);
    assert.equal(moodPresentation(bright, turn, 'speaking', 'settled', 'neutral').emotion, 'sad');
    assert.equal(presentedActivity('answered', true, false, 'play', turn.comfort), 'settled');
  }
});

test('comfort continues until a new explicit context, and accepts corrections in both languages', () => {
  const concerned = conversationMood(daily, "I'm sad");
  assert.equal(conversationMood(daily, 'Tell me something', 'curious', concerned).comfort, true);
  for (const words of ["I'm not sad", 'I am happy now', 'I feel better', 'Mình không còn buồn nữa', 'Con vui rồi']) {
    const next = conversationMood(daily, words, 'sad', concerned);
    assert.equal(next.comfort, false, words);
    assert.equal(next.emotion, 'happy', words);
  }
  assert.equal(conversationMood(daily, 'Mình buồn ngủ', 'sad').emotion, 'sleepy');
  assert.equal(conversationMood(daily, 'Mình buồn ngủ', 'sad').comfort, false);
});

test('current context never alters the stored daily baseline or retains the child’s words', () => {
  const before = JSON.stringify(daily);
  const privateWords = "I'm sad about my private toy 123456";
  const turn = conversationMood(daily, privateWords);
  assert.equal(JSON.stringify(daily), before);
  assert.ok(!JSON.stringify(turn).includes(privateWords));
  const otherProfile = { ...daily, profile: 'binh' };
  assert.equal(conversationMood(otherProfile, 'Hello', 'neutral', turn).comfort, false);
  assert.equal(moodPresentation(otherProfile, turn, 'answered', 'settled', 'neutral').comfort, false);
});

test('rest, listening, and thinking override mood; gentle touch remains available during comfort', () => {
  const turn = conversationMood(daily, "I'm sad");
  assert.equal(moodPresentation(daily, turn, 'resting', 'sleep', 'sleepy').emotion, 'sleepy');
  assert.equal(moodPresentation(daily, turn, 'listening', 'settled', 'neutral').emotion, 'listening');
  assert.equal(moodPresentation(daily, turn, 'thinking', 'settled', 'neutral').emotion, 'thinking');
  assert.equal(moodPresentation(daily, turn, 'answered', 'cuddle', 'love').emotion, 'love');
  assert.equal(moodPresentation(daily, turn, 'answered', 'cuddle', 'love').comfort, true);
  assert.equal(moodPresentation(daily, null, 'answered', 'pout', activityEmotion('pout')).emotion, 'sulky');
});

test('voice mood uses clear live transcripts, never fixed samples or uncertain recognition', () => {
  const transcript = { text: "I'm sad", uncertain_spans: [] };
  assert.equal(spokenMoodText({ provider_mode: 'real', transcript }), transcript.text);
  assert.equal(spokenMoodText({ provider_mode: 'fake', transcript }), '');
  assert.equal(spokenMoodText({ provider_mode: 'real', transcript: { ...transcript, uncertain_spans: [{}] } }), '');
  assert.equal(spokenMoodText({ provider_mode: 'real', transcript: null }), '');
});

test('emotion intensity changes face geometry and all rendering values stay finite', () => {
  const gentle = getMiuPose('happy', undefined, undefined, .2);
  const strong = getMiuPose('happy', undefined, undefined, .95);
  assert.ok(strong.blush > gentle.blush);
  assert.ok(strong.mouthScale > gentle.mouthScale);
  assert.notEqual(strong.armL, gentle.armL);
  for (const intensity of [-1, 0, .2, .5, 1, 2, Number.NaN]) {
    const pose = getMiuPose('sulky', undefined, undefined, intensity);
    assert.ok(Object.values(pose).every(value => typeof value !== 'number' || Number.isFinite(value)));
  }
  assert.equal(emotionLevel(.2), 1);
  assert.equal(emotionLevel(.9), 5);
  assert.equal(emotionLevel(5), 5);
  assert.equal(emotionLevel(Number.NaN), 0);
});

test('daily mood changes idle pace while every routine still settles and sleeps', () => {
  assert.ok(dailyEnergy(daily) >= .25 && dailyEnergy(daily) <= .95);
  const calm = createIdleRoutine(() => .5, { energy: .25, poutChance: 0 });
  const lively = createIdleRoutine(() => .5, { energy: .95, poutChance: .3 });
  assert.ok(calm[3][0] > lively[3][0]);
  assert.deepEqual(calm.at(-1), [90000, 'sleep']);
  assert.deepEqual(lively.at(-1), [90000, 'sleep']);
  for (const routine of [calm, lively]) {
    assert.ok(routine.some(([, activity]) => activity === 'play'));
    assert.ok(routine.some(([, activity]) => activity === 'snack'));
  }
});
