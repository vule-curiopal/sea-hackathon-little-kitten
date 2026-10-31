import type { CatReaction } from './miu-behavior.ts';

export type Point = { x: number; y: number };
export type TouchZone = 'head' | 'nose' | 'belly' | 'paw' | 'tail' | null;
export const HOLD_MS = 650;
export const STROKE_DISTANCE = 28;

// Coordinates use the artwork's 400 × 440 viewBox, independent of device pixels.
export function artworkPoint(client: Point, bounds: { left: number; top: number; width: number; height: number }): Point {
  return { x: (client.x - bounds.left) / Math.max(1, bounds.width) * 400, y: (client.y - bounds.top) / Math.max(1, bounds.height) * 440 };
}

function inOval(point: Point, x: number, y: number, rx: number, ry: number) {
  return ((point.x - x) / rx) ** 2 + ((point.y - y) / ry) ** 2 <= 1;
}

export function catTouchZone(point: Point): TouchZone {
  if (inOval(point, 200, 211, 36, 31)) return 'nose';
  if (inOval(point, 200, 168, 137, 100) || (point.y >= 28 && point.y < 110 && point.x >= 82 && point.x <= 318)) return 'head';
  if (inOval(point, 200, 350, 57, 45)) return 'belly';
  if (inOval(point, 132, 322, 33, 49) || inOval(point, 268, 322, 33, 49) || inOval(point, 160, 405, 39, 24) || inOval(point, 240, 405, 39, 24)) return 'paw';
  if (point.x > 298 && point.x < 380 && point.y > 255 && point.y < 405) return 'tail';
  return null;
}

export function touchReaction(zone: TouchZone, distance = 0, duration = 0): CatReaction | null {
  if (!zone) return null;
  if (duration >= HOLD_MS && distance < STROKE_DISTANCE) return 'cuddle';
  if (distance >= STROKE_DISTANCE) return zone === 'belly' ? 'tickle' : 'purr';
  return zone === 'nose' ? 'boop' : zone === 'belly' ? 'tickle' : zone === 'paw' ? 'highfive' : zone === 'tail' ? 'play' : 'purr';
}

export function snackReachesMiu(point: Point) { return inOval(point, 200, 210, 100, 85); }

export function clampToy(point: Point): Point {
  return { x: Math.max(26, Math.min(374, point.x)), y: Math.max(28, Math.min(412, point.y)) };
}
