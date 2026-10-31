import test from 'node:test';
import assert from 'node:assert/strict';
import { HoldToTalk } from './hold-to-talk.ts';

function setup(allowed = true) {
  const calls = { start: 0, send: 0, cancel: 0 };
  const gesture = new HoldToTalk({ start: () => { calls.start++; return allowed; }, send: () => { calls.send++; }, cancel: () => { calls.cancel++; } });
  return { gesture, calls };
}

test('one held pointer records once and releasing that pointer submits exactly once', () => {
  const { gesture, calls } = setup();
  assert.equal(gesture.press('pointer:1'), true);
  assert.equal(gesture.press('pointer:1'), false);
  assert.equal(gesture.press('pointer:2'), false);
  assert.equal(gesture.release('pointer:2'), false);
  assert.deepEqual(calls, { start: 1, send: 0, cancel: 0 });
  assert.equal(gesture.release('pointer:1'), true);
  assert.equal(gesture.release('pointer:1'), false);
  gesture.cancel('pointer:1'); // lostpointercapture follows a normal release.
  assert.deepEqual(calls, { start: 1, send: 1, cancel: 0 });
  assert.equal(gesture.press('pointer:3'), true);
  assert.deepEqual(calls, { start: 2, send: 1, cancel: 0 });
});

test('holding Space or Enter uses the same one-turn boundary and ignores repeated presses', () => {
  for (const key of [' ', 'Enter']) {
    const { gesture, calls } = setup();
    assert.equal(gesture.press(`key:${key}`), true);
    assert.equal(gesture.press(`key:${key}`), false);
    assert.equal(gesture.release('pointer:1'), false);
    assert.equal(gesture.release(`key:${key}`), true);
    assert.deepEqual(calls, { start: 1, send: 1, cancel: 0 });
  }
});

test('cancellation, lost capture, or focus loss discards instead of submitting', () => {
  const { gesture, calls } = setup();
  gesture.press('pointer:1');
  gesture.cancel('pointer:2');
  assert.equal(calls.cancel, 0);
  gesture.cancel();
  gesture.cancel('pointer:1');
  assert.equal(gesture.release('pointer:1'), false);
  assert.deepEqual(calls, { start: 1, send: 0, cancel: 1 });
  assert.equal(gesture.press('pointer:2'), true);
});

test('connection, playback, or Stop actions that do not start recording cannot send on release', () => {
  const { gesture, calls } = setup(false);
  assert.equal(gesture.press('pointer:1'), false);
  assert.equal(gesture.activeOwner, null);
  assert.equal(gesture.release('pointer:1'), false);
  assert.deepEqual(calls, { start: 1, send: 0, cancel: 0 });
});

test('external capture completion clears ownership so a later release cannot submit again', () => {
  const { gesture, calls } = setup();
  gesture.press('accessible');
  gesture.clear();
  assert.equal(gesture.release('accessible'), false);
  assert.equal(gesture.press('accessible'), true);
  assert.equal(gesture.release('accessible'), true);
  assert.deepEqual(calls, { start: 2, send: 1, cancel: 0 });
});
