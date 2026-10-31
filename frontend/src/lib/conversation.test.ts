import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationReducer as reduce, initialConversation } from './conversation.ts';
import { getDemoReply } from './demo.ts';
import { validateAuth } from './validation.ts';
import { emotions, getMiuPose } from './miu-pose.ts';

test('pausing blocks an in-flight answer and waking preserves earlier answers', () => {
  const answer = { id: 1, text: 'Hello!', emotion: 'happy' as const };
  const replied = reduce(reduce(initialConversation, { type: 'think' }), { type: 'reply', answer, speaking: false });
  const paused = reduce(reduce(replied, { type: 'think' }), { type: 'pause' });
  assert.equal(reduce(paused, { type: 'reply', answer: { ...answer, id: 2 }, speaking: true }), paused);
  const awake = reduce(paused, { type: 'wake' });
  assert.equal(awake.phase, 'answered');
  assert.deepEqual(awake.messages, [{ ...answer, role: 'miu' }]);
});

test('a new conversation clears answers without waking a paused Miu', () => {
  const reset = reduce({ phase: 'resting', emotion: 'sleepy', messages: [{ id: 1, role: 'miu', text: 'A story', emotion: 'curious' }] }, { type: 'reset' });
  assert.deepEqual(reset, { phase: 'resting', emotion: 'sleepy', messages: [] });
});

test('voice lifecycle does not start listening while speaking or thinking', () => {
  const thinking = reduce(initialConversation, { type: 'think' });
  assert.equal(reduce(thinking, { type: 'listen', requestId: 2 }), thinking);
  const speaking = reduce(thinking, { type: 'reply', answer: { id: 1, text: 'Hi!', emotion: 'happy' }, speaking: true });
  assert.equal(reduce(speaking, { type: 'listen', requestId: 2 }), speaking);
  assert.equal(reduce(speaking, { type: 'finish' }).phase, 'answered');
});

test('voice captions can arrive before audio; only playback starts the speaking pose', () => {
  const pending = reduce(initialConversation, { type: 'think' });
  const caption = reduce(pending, { type: 'reply', answer: { id: 2, text: 'Reference audio', emotion: 'neutral', source: 'reference' }, speaking: false });
  assert.equal(caption.phase, 'answered');
  assert.equal(caption.messages[0].source, 'reference');
  const playing = reduce(caption, { type: 'speak' });
  assert.equal(playing.phase, 'speaking');
  assert.equal(reduce(playing, { type: 'finish' }).phase, 'answered');
  const paused = reduce(caption, { type: 'pause' });
  assert.equal(reduce(paused, { type: 'speak' }), paused);
});

test('typed messages appear immediately, followed by Miu’s reply in the same history', () => {
  const text = 'What do cats dream about?';
  const user = { id: 1, role: 'user' as const, text, source: 'typed' as const };
  const waiting = reduce(initialConversation, { type: 'think', requestId: 1, user });
  assert.deepEqual(waiting.messages, [user]);
  const reply = getDemoReply(text, 'en');
  const next = reduce(waiting, { type: 'reply', answer: { id: 1, ...reply }, speaking: false });
  assert.deepEqual(next.messages, [user, { id: 1, ...reply, role: 'miu' }]);
});

test('demo answers follow the chosen language and emotion', () => {
  assert.match(getDemoReply('khủng long', 'vi').text, /khủng long/);
  assert.match(getDemoReply('khủng long', 'en').text, /dinosaurs/);
  assert.equal(getDemoReply('I feel sad', 'en').emotion, 'sad');
  assert.equal(getDemoReply('I love you', 'en').emotion, 'love');
});

test('account validation needs only username/password and preserves backend registration and login rules', () => {
  assert.deepEqual(validateAuth({ username: '', password: '123' }, false), { username: 'usernameError', password: 'passwordError' });
  assert.deepEqual(validateAuth({ username: 'a@b', password: '123' }, false), { username: 'usernameError', password: 'passwordError' });
  assert.deepEqual(validateAuth({ username: 'lan.nguyen', password: 'long-password-12' }, false), {});
  assert.deepEqual(validateAuth({ username: 'bé_mèo', password: 'long-password-12' }, false), { username: 'usernameError' });
  assert.deepEqual(validateAuth({ username: '   ', password: 'long-password-12' }, false), { username: 'usernameError' });
  assert.deepEqual(validateAuth({ username: 'x'.repeat(81), password: 'long-password-12' }, false), { username: 'usernameError' });
  assert.deepEqual(validateAuth({ username: 'lan.nguyen', password: 'demo1234' }, false), { password: 'passwordError' });
  assert.deepEqual(validateAuth({ username: 'sam', password: '1' }, true), {});
});

test('all fifteen expressions have valid SVG values and unknown emotions are neutral', () => {
  assert.equal(emotions.length, 15);
  for (const emotion of emotions) {
    const pose = getMiuPose(emotion);
    assert.ok(pose.mouthLine.startsWith('M'));
    assert.ok(pose.earL.startsWith('rotate('));
    assert.ok(Object.values(pose).every(value => typeof value !== 'number' || Number.isFinite(value)));
  }
  assert.deepEqual(getMiuPose('unknown'), getMiuPose('neutral'));
});

test('a little pout has puffy cheeks, a side glance, folded paws, and its own soft expression', () => {
  const pout = getMiuPose('sulky');
  const calm = getMiuPose('neutral');
  const sad = getMiuPose('sad');
  assert.equal(pout.puff, 1);
  assert.ok(pout.cheekRx > calm.cheekRx);
  assert.ok(pout.irisLx < calm.irisLx);
  assert.notEqual(pout.armL, calm.armL);
  assert.notEqual(pout.mouthLine, sad.mouthLine);
  assert.notEqual(pout.browL, sad.browL);
  assert.equal(pout.tear, 0);
});
