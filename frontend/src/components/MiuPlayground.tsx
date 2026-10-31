import { useEffect, useId, useRef, useState, type PointerEvent } from 'react';
import Miu from './Miu';
import Icon from './Icon';
import YarnBall from './YarnBall';
import FishSnack from './FishSnack';
import type { Emotion } from '../lib/miu-pose';
import type { CatActivity, CatReaction } from '../lib/miu-behavior';
import type { TranslationKey } from '../lib/i18n';
import { artworkPoint, catTouchZone, clampToy, HOLD_MS, snackReachesMiu, STROKE_DISTANCE, touchReaction, type Point, type TouchZone } from '../lib/miu-touch';

type Toy = 'yarn' | 'fish';
type Stroke = { id: number; zone: TouchZone; last: Point; distance: number; started: number; lastReaction: number; emitted: boolean; held: boolean };
const toyHome: Record<Toy, Point> = { yarn: { x: 358, y: 365 }, fish: { x: 43, y: 382 } };

export default function MiuPlayground({ emotion, activity, alive, speaking, mouthLevel, comfort = false, canInteract, resting, sleeping, label, t, onReact, onWake, onCancel }: {
  emotion: Emotion; activity: CatActivity; alive: boolean; speaking: boolean;
  mouthLevel?: number; comfort?: boolean;
  canInteract: boolean; resting: boolean; sleeping: boolean; label: string;
  t: (key: TranslationKey) => string; onReact: (reaction: CatReaction) => void; onWake: () => void; onCancel: () => void;
}) {
  const hintId = useId();
  const stage = useRef<HTMLDivElement>(null);
  const stroke = useRef<Stroke | null>(null);
  const drag = useRef<{ id: number; toy: Toy; offset: Point; last: Point; distance: number; lastReaction: number } | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const snackTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const ignoreClickUntil = useRef(0);
  const feedbackId = useRef(0);
  const [feedback, setFeedback] = useState<{ id: number; point: Point; heart: boolean } | null>(null);
  const [positions, setPositions] = useState(toyHome);
  const [dragging, setDragging] = useState<Toy | null>(null);

  useEffect(() => {
    if (canInteract && !resting) return;
    clearTimeout(holdTimer.current); clearTimeout(feedbackTimer.current); clearTimeout(snackTimer.current);
    stroke.current = null; drag.current = null;
    setDragging(null); setPositions(toyHome); setFeedback(null);
  }, [canInteract, resting]);
  useEffect(() => () => {
    clearTimeout(holdTimer.current); clearTimeout(feedbackTimer.current); clearTimeout(snackTimer.current);
  }, []);
  useEffect(() => {
    if (!canInteract || resting || drag.current) return;
    clearTimeout(snackTimer.current);
    if (activity === 'snack') {
      setPositions({ ...toyHome, fish: { x: 200, y: 228 } });
      snackTimer.current = setTimeout(() => setPositions(toyHome), 1800);
    } else setPositions(toyHome);
    return () => clearTimeout(snackTimer.current);
  }, [activity, canInteract, resting]);

  function react(reaction: CatReaction, point: Point = { x: 200, y: 190 }) {
    if (comfort && ['purr', 'tickle', 'play', 'snack'].includes(reaction)) reaction = 'cuddle';
    onReact(reaction);
    setFeedback({ id: ++feedbackId.current, point: clampToy(point), heart: reaction === 'purr' || reaction === 'cuddle' });
    clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => setFeedback(null), 1000);
  }

  function capture(event: PointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function pointOnCat(event: PointerEvent<HTMLButtonElement>) {
    return artworkPoint({ x: event.clientX, y: event.clientY }, event.currentTarget.getBoundingClientRect());
  }
  function pointOnStage(event: PointerEvent<HTMLButtonElement>) {
    return artworkPoint({ x: event.clientX, y: event.clientY }, stage.current!.getBoundingClientRect());
  }
  function beginStroke(event: PointerEvent<HTMLButtonElement>) {
    if ((!canInteract && !resting) || !event.isPrimary || event.button !== 0 || stroke.current || drag.current) return;
    const point = pointOnCat(event);
    const zone = catTouchZone(point);
    if (!zone && !sleeping && !resting) return;
    capture(event);
    ignoreClickUntil.current = performance.now() + 1000;
    stroke.current = { id: event.pointerId, zone, last: point, distance: 0, started: performance.now(), lastReaction: 0, emitted: false, held: false };
    if (sleeping || resting) return;
    holdTimer.current = setTimeout(() => {
      const current = stroke.current;
      if (!current || current.id !== event.pointerId || current.distance >= STROKE_DISTANCE) return;
      current.held = true;
      react('cuddle', current.last);
    }, HOLD_MS);
  }
  function moveStroke(event: PointerEvent<HTMLButtonElement>) {
    const current = stroke.current;
    if (!current || current.id !== event.pointerId || current.held || sleeping || resting) return;
    const point = pointOnCat(event);
    current.distance += Math.hypot(point.x - current.last.x, point.y - current.last.y);
    current.last = point;
    if (current.distance < STROKE_DISTANCE) return;
    clearTimeout(holdTimer.current);
    if (performance.now() - current.lastReaction < 280) return;
    const reaction = touchReaction(current.zone, current.distance);
    if (reaction) { react(reaction, point); current.emitted = true; current.lastReaction = performance.now(); }
  }
  function endStroke(event: PointerEvent<HTMLButtonElement>) {
    ignoreClickUntil.current = performance.now() + 1000;
    const current = stroke.current;
    if (!current || current.id !== event.pointerId) return;
    clearTimeout(holdTimer.current);
    stroke.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (sleeping || resting) { onWake(); return; }
    if (!canInteract || current.held || current.emitted) return;
    const reaction = touchReaction(current.zone, current.distance, performance.now() - current.started);
    if (reaction) react(reaction, current.last);
  }
  function cancelPointer(event: PointerEvent<HTMLButtonElement>) {
    if (stroke.current?.id !== event.pointerId && drag.current?.id !== event.pointerId) return;
    clearTimeout(holdTimer.current); clearTimeout(snackTimer.current);
    stroke.current = null; drag.current = null;
    setDragging(null); setPositions(toyHome); setFeedback(null);
    ignoreClickUntil.current = performance.now() + 1000;
    onCancel();
  }

  function beginToy(event: PointerEvent<HTMLButtonElement>, toy: Toy) {
    if (!canInteract || resting || !event.isPrimary || event.button !== 0 || stroke.current || drag.current) return;
    capture(event);
    clearTimeout(snackTimer.current);
    const point = pointOnStage(event);
    drag.current = { id: event.pointerId, toy, offset: { x: point.x - positions[toy].x, y: point.y - positions[toy].y }, last: point, distance: 0, lastReaction: performance.now() };
    setDragging(toy);
    ignoreClickUntil.current = performance.now() + 1000;
    if (toy === 'yarn') onReact('play');
    else onCancel();
  }
  function moveToy(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    const point = pointOnStage(event);
    current.distance += Math.hypot(point.x - current.last.x, point.y - current.last.y);
    current.last = point;
    const position = clampToy({ x: point.x - current.offset.x, y: point.y - current.offset.y });
    setPositions(previous => ({ ...previous, [current.toy]: position }));
    if (performance.now() - current.lastReaction > 280) { if (current.toy === 'yarn') onReact('play'); else onCancel(); current.lastReaction = performance.now(); }
  }
  function endToy(event: PointerEvent<HTMLButtonElement>) {
    ignoreClickUntil.current = performance.now() + 1000;
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    const point = pointOnStage(event);
    const position = clampToy({ x: point.x - current.offset.x, y: point.y - current.offset.y });
    drag.current = null; setDragging(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (current.toy === 'fish' && (snackReachesMiu(position) || current.distance < 12)) {
      setPositions({ ...toyHome, fish: { x: 200, y: 228 } });
      react('snack', { x: 200, y: 210 });
      snackTimer.current = setTimeout(() => setPositions(toyHome), 900);
    } else {
      setPositions(toyHome);
      if (current.toy === 'yarn') react('play', position);
    }
  }
  function toyClick(toy: Toy) {
    if (performance.now() < ignoreClickUntil.current || !canInteract || resting) return;
    react(toy === 'yarn' ? 'play' : 'snack');
  }
  const gaze = dragging ? { x: (positions[dragging].x - 200) / 18, y: (positions[dragging].y - 175) / 28 } : undefined;

  return <div className="cat-companion" data-activity={activity}>
    <div className="companion-stage" ref={stage} data-dragging={dragging ?? undefined}>
      <button className="pet-button touch-surface" aria-label={t(sleeping || resting ? 'wake' : 'touchMiu')} aria-describedby={hintId} disabled={!canInteract && !resting}
        onPointerDown={beginStroke} onPointerMove={moveStroke} onPointerUp={endStroke} onPointerCancel={cancelPointer} onLostPointerCapture={cancelPointer}
        onContextMenu={event => event.preventDefault()}
        onClick={() => { if (performance.now() < ignoreClickUntil.current) return; if (sleeping || resting) onWake(); else if (canInteract) react('purr'); }}
        onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); if (sleeping || resting) onWake(); else if (canInteract) react('purr'); } }}>
        <Miu emotion={dragging ? 'neutral' : emotion} activity={activity} alive={alive} speaking={speaking} mouthLevel={mouthLevel} gaze={gaze} className={dragging ? 'is-tracking' : ''} label={label} />
      </button>
      {(['yarn', 'fish'] as const).map(toy => <button key={toy} className={`touch-toy touch-toy-${toy}`} style={{ left: `${positions[toy].x / 4}%`, top: `${positions[toy].y / 4.4}%` }} aria-label={t(toy === 'yarn' ? 'dragYarn' : 'offerFish')} disabled={!canInteract || resting || comfort}
        onPointerDown={event => beginToy(event, toy)} onPointerMove={moveToy} onPointerUp={endToy} onPointerCancel={cancelPointer} onLostPointerCapture={cancelPointer} onContextMenu={event => event.preventDefault()} onClick={() => toyClick(toy)}>
        {toy === 'yarn' ? <YarnBall /> : <FishSnack />}
      </button>)}
      {feedback && <span key={feedback.id} className={`touch-feedback ${feedback.heart ? 'is-heart' : ''}`} style={{ left: `${feedback.point.x / 4}%`, top: `${feedback.point.y / 4.4}%` }} aria-hidden="true"><Icon name={feedback.heart ? 'heart' : 'sparkle'} /></span>}
      {activity === 'purr' && <span className="purr" aria-hidden="true">{t('purr')}<Icon name="heart" /></span>}
    </div>
    <p className="sr-only" id={hintId}>{t(resting || sleeping ? 'touchWakeHint' : 'touchGuide')}</p>
  </div>;
}
