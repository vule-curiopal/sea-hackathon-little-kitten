import test from 'node:test';
import assert from 'node:assert/strict';
import { canStartKeyboardHold, heldTalkKey, HoldToTalk, type HoldKeyboardContext } from './hold-to-talk.ts';

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

test('a pre-start false render does not clear a new owner before React renders recording', () => {
  const { gesture, calls } = setup();
  gesture.observeRecording(false);
  gesture.press('key:Space');
  gesture.observeRecording(false); // A queued effect from the preceding render.
  assert.equal(gesture.activeOwner, 'key:Space');
  assert.equal(gesture.release('key:Space'), true);
  assert.deepEqual(calls, { start: 1, send: 1, cancel: 0 });
});

test('observed capture ending externally clears a held gesture without submitting it again', () => {
  const { gesture, calls } = setup();
  gesture.press('pointer:1'); gesture.observeRecording(true);
  gesture.observeRecording(false);
  assert.equal(gesture.activeOwner, null);
  assert.equal(gesture.release('pointer:1'), false);
  assert.deepEqual(calls, { start: 1, send: 0, cancel: 0 });
});

test('releasing during microphone preparation remains an explicit send/cancel decision for the capture controller', () => {
  const { gesture, calls } = setup();
  gesture.press('key:Space'); gesture.observeRecording(true);
  // Intent is recording, but actual permission/readiness remains capture-owned.
  assert.equal(gesture.release('key:Space'), true);
  assert.equal(gesture.release('key:Space'), false);
  assert.deepEqual(calls, { start: 1, send: 1, cancel: 0 });
});

test('a failed synchronous start and a cancellation during start cannot leave an armed owner', () => {
  const failure = new HoldToTalk({ start: () => { throw new Error('unit start failure'); }, send: () => assert.fail('must not send'), cancel: () => {} });
  assert.throws(() => failure.press('key:Space'), /unit start failure/);
  assert.equal(failure.activeOwner, null);
  assert.equal(failure.release('key:Space'), false);
  let canceled!: HoldToTalk;
  canceled = new HoldToTalk({ start: () => { canceled.cancel(); return true; }, send: () => assert.fail('must not send'), cancel: () => {} });
  assert.equal(canceled.press('pointer:1'), false);
  assert.equal(canceled.activeOwner, null);
});

const room: HoldKeyboardContext = { enabled: true, disabled: false, dialogOpen: false, target: 'room' };

test('unfocused room Space starts a hold, while Enter is limited to the microphone', () => {
  assert.equal(canStartKeyboardHold({ key: ' ', code: 'Space' }, room), true);
  assert.equal(canStartKeyboardHold({ key: 'Enter' }, room), false);
  assert.equal(canStartKeyboardHold({ key: ' ', code: 'Space' }, { ...room, target: 'microphone' }), true);
  assert.equal(canStartKeyboardHold({ key: 'Enter' }, { ...room, target: 'microphone' }), true);
  assert.equal(heldTalkKey({ key: 'Spacebar' }), 'Space');
  assert.equal(heldTalkKey({ key: 'Escape' }), null);
});

test('typing, selects, links, other buttons and dialogs keep their own keyboard input', () => {
  for (const key of [' ', 'Enter']) {
    assert.equal(canStartKeyboardHold({ key }, { ...room, target: 'interactive' }), false);
    assert.equal(canStartKeyboardHold({ key }, { ...room, dialogOpen: true }), false);
    assert.equal(canStartKeyboardHold({ key }, { ...room, enabled: false }), false);
    assert.equal(canStartKeyboardHold({ key }, { ...room, disabled: true }), false);
  }
});

test('autorepeat, composition, claimed events and modifier combinations cannot start global recording', () => {
  for (const guard of ['repeat', 'isComposing', 'defaultPrevented', 'altKey', 'ctrlKey', 'metaKey', 'shiftKey']) {
    assert.equal(canStartKeyboardHold({ key: ' ', [guard]: true }, room), false);
  }
});

test('global keyboard repeat and mixed input owners produce one recording and one release', () => {
  const { gesture, calls } = setup();
  if (canStartKeyboardHold({ key: ' ' }, room)) gesture.press('key:Space');
  if (canStartKeyboardHold({ key: ' ', repeat: true }, room)) gesture.press('key:Space');
  assert.equal(gesture.press('pointer:1'), false);
  assert.equal(gesture.release('pointer:1'), false);
  assert.equal(gesture.release('key:Space'), true);
  assert.deepEqual(calls, { start: 1, send: 1, cancel: 0 });
});
