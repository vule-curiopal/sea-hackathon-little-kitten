import test from 'node:test';
import assert from 'node:assert/strict';
import { artworkPoint, catTouchZone, clampToy, HOLD_MS, snackReachesMiu, touchReaction } from './miu-touch.ts';
import { activityEmotion, reactionDuration } from './miu-behavior.ts';
import { getMiuPose } from './miu-pose.ts';

test('the same direct touches hit the same body parts on phone, tablet, and desktop layouts', () => {
  const targets = [
    { point: { x: 200, y: 130 }, zone: 'head' },
    { point: { x: 200, y: 211 }, zone: 'nose' },
    { point: { x: 200, y: 350 }, zone: 'belly' },
    { point: { x: 268, y: 320 }, zone: 'paw' },
    { point: { x: 160, y: 405 }, zone: 'paw' },
    { point: { x: 350, y: 290 }, zone: 'tail' },
  ];
  for (const width of [218, 255, 330, 340]) {
    const bounds = { left: 73, top: 287, width, height: width * 1.1 };
    for (const { point, zone } of targets) {
      const client = { x: bounds.left + point.x / 400 * bounds.width, y: bounds.top + point.y / 440 * bounds.height };
      assert.equal(catTouchZone(artworkPoint(client, bounds)), zone, `${zone} at ${width}px`);
    }
  }
});

test('taps, moving strokes, and held cuddles stay distinct', () => {
  assert.equal(touchReaction('nose'), 'boop');
  assert.equal(touchReaction('belly'), 'tickle');
  assert.equal(touchReaction('paw'), 'highfive');
  assert.equal(touchReaction('head', 50, 120), 'purr');
  assert.equal(touchReaction('belly', 100, 900), 'tickle');
  assert.equal(touchReaction('head', 3, HOLD_MS), 'cuddle');
  assert.equal(touchReaction('nose', 2, HOLD_MS - 1), 'boop');
  assert.equal(touchReaction(null, 100, 1000), null);
  assert.equal(catTouchZone({ x: 10, y: 10 }), null);
  assert.equal(catTouchZone({ x: 200, y: 15 }), null);
});

test('a fish must reach Miu’s face and toys stay inside the play area', () => {
  assert.equal(snackReachesMiu({ x: 200, y: 211 }), true);
  assert.equal(snackReachesMiu({ x: 160, y: 240 }), true);
  assert.equal(snackReachesMiu({ x: 43, y: 382 }), false);
  assert.equal(snackReachesMiu({ x: 200, y: 350 }), false);
  assert.deepEqual(clampToy({ x: -800, y: 2000 }), { x: 26, y: 412 });
});

test('every touch response has a bounded duration and a valid distinct pose', () => {
  for (const [activity, duration] of Object.entries(reactionDuration)) {
    const pose = getMiuPose(activityEmotion(activity as keyof typeof reactionDuration), activity as keyof typeof reactionDuration);
    assert.ok(duration > 0 && duration <= 5200);
    assert.ok(Object.values(pose).every(value => typeof value !== 'number' || Number.isFinite(value)));
  }
  const looking = getMiuPose('neutral', 'play', { x: 1000, y: -1000 });
  assert.equal(looking.irisLx, 160);
  assert.equal(looking.irisY, 162);
  assert.notEqual(getMiuPose('excited', 'highfive').armR, getMiuPose('neutral').armR);
});
