import test from 'node:test';
import assert from 'node:assert/strict';
import { activityEmotion, createIdleRoutine, idleMoment, presentedActivity } from './miu-behavior.ts';

test('an untouched Miu has a complete local cat routine before falling asleep', () => {
  const routine = createIdleRoutine(() => .25);
  assert.equal(idleMoment(routine, 0).activity, 'settled');
  for (const activity of ['look', 'ears', 'groom', 'stretch', 'play', 'snack']) assert.ok(routine.some(([, item]) => item === activity));
  assert.equal(idleMoment(routine, 82000).activity, 'doze');
  assert.deepEqual(idleMoment(routine, 90000), { activity: 'sleep', nextIn: null });
  assert.deepEqual(idleMoment(routine, 24 * 60 * 60 * 1000), { activity: 'sleep', nextIn: null });
});

test('the next activity is scheduled from elapsed time, including delayed timers', () => {
  const routine = createIdleRoutine(() => .5);
  const first = routine[1]; const next = routine[2];
  assert.equal(idleMoment(routine, first[0] + 1).nextIn, next[0] - first[0] - 1);
  assert.deepEqual(idleMoment(routine, 87000), { activity: 'doze', nextIn: 3000 });
  assert.equal(idleMoment(routine, -1).activity, 'settled');
});

test('conversation, capture, hidden tabs, and explicit rest override play and touch', () => {
  for (const phase of ['listening', 'thinking', 'speaking'] as const) {
    assert.equal(presentedActivity(phase, true, false, 'play'), 'settled');
    assert.equal(presentedActivity(phase, true, false, 'purr'), 'settled');
  }
  assert.equal(presentedActivity('answered', true, true, 'sleep'), 'settled');
  assert.equal(presentedActivity('answered', false, false, 'play'), 'settled');
  assert.equal(presentedActivity('resting', true, false, 'wake'), 'sleep');
  assert.equal(presentedActivity('answered', true, false, 'wake'), 'wake');
});

test('a comfort response suppresses lively idle activities', () => {
  const routine = createIdleRoutine(() => .5);
  for (const [elapsed, activity] of routine) {
    if (['groom', 'stretch', 'play', 'snack', 'pout'].includes(activity)) assert.equal(idleMoment(routine, elapsed, true).activity, 'settled');
    if (activity === 'look') assert.equal(idleMoment(routine, elapsed, true).activity, 'look');
  }
});

test('a playful pout follows the yarn occasionally and settles without needing the child', () => {
  const routine = createIdleRoutine(() => 0);
  const index = routine.findIndex(([, activity]) => activity === 'pout');
  assert.ok(index > 0);
  assert.equal(routine[index - 1][1], 'play');
  assert.equal(routine.filter(([, activity]) => activity === 'pout').length, 1);
  assert.equal(routine[index + 1][0] - routine[index][0], 2400);
  assert.equal(idleMoment(routine, routine[index + 1][0]).activity, 'settled');
  assert.equal(idleMoment(routine, routine[index][0], true).activity, 'settled');
  assert.equal(activityEmotion('pout'), 'sulky');
  assert.ok(!createIdleRoutine(() => .9).some(([, activity]) => activity === 'pout'));
  assert.equal(presentedActivity('listening', true, false, 'pout'), 'settled');
  assert.equal(presentedActivity('resting', true, false, 'pout'), 'sleep');
});

test('Miu chooses varied independent routines, including its own snacks and play', () => {
  assert.notDeepEqual(createIdleRoutine(() => 0), createIdleRoutine(() => .9));
  for (const value of [0, .1, .25, .5, .75, .9, .999999, 1]) {
    const routine = createIdleRoutine(() => value);
    assert.ok(routine.some(([, activity]) => activity === 'snack'));
    assert.ok(routine.some(([, activity]) => activity === 'play'));
    for (let index = 1; index < routine.length; index++) assert.ok(routine[index][0] > routine[index - 1][0]);
    const actions = routine.filter(([, activity]) => activity !== 'settled');
    for (let index = 1; index < actions.length; index++) assert.notEqual(actions[index][1], actions[index - 1][1]);
  }
});
