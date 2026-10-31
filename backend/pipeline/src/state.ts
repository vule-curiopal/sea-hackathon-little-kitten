// Compatibility entry point for existing integration imports.
export { SessionService as DemoState } from './modules/sessions/session.service.js';
export { MBTI } from './modules/sessions/session.types.js';
export type { Profile, Session, TurnRecord } from './modules/sessions/session.types.js';
export { fingerprint, uuid } from './modules/sessions/session.utils.js';
