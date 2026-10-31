import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { initialConversation, type ConversationEvent } from './conversation.ts';
import { HISTORY_KEY, historyReducer, latestHistoryRequestId, readConversationHistory, saveConversationHistory, type ConversationHistory } from './conversation-history.ts';

type HistoryStorage = Pick<Storage, 'getItem' | 'setItem'>;
export function accountHistoryStorage(storage: HistoryStorage, namespace: string): HistoryStorage {
  const key = `${HISTORY_KEY}.account.${encodeURIComponent(namespace)}`;
  return { getItem: () => storage.getItem(key), setItem: (_key, value) => storage.setItem(key, value) };
}

export function readScopedHistory(storage: HistoryStorage, namespace?: string, persist = true): ConversationHistory {
  return persist ? readConversationHistory(namespace ? accountHistoryStorage(storage, namespace) : storage) : {};
}

export function saveScopedHistory(storage: HistoryStorage, history: ConversationHistory, namespace?: string, persist = true): boolean {
  return !persist || saveConversationHistory(namespace ? accountHistoryStorage(storage, namespace) : storage, history);
}

type Snapshot = { scope: string; history: ConversationHistory };
type HistoryAction = { type: 'scope'; snapshot: Snapshot } | { type: 'event'; scope: string; profile: string; event: ConversationEvent };
function scopedReducer(previous: Snapshot, action: HistoryAction): Snapshot {
  if (action.type === 'scope') return action.snapshot;
  if (action.scope !== previous.scope) return previous;
  const history = historyReducer(previous.history, action);
  return history === previous.history ? previous : { ...previous, history };
}

export function useConversationHistory(profile: string, namespace?: string, persist = true) {
  const scope = JSON.stringify([namespace ?? null, persist]);
  const restore = () => {
    if (!persist) return {};
    try { return readScopedHistory(window.localStorage, namespace, persist); } catch { return {}; }
  };
  const [snapshot, update] = useReducer(scopedReducer, undefined, () => ({ scope, history: restore() }));
  const requestRef = useRef(latestHistoryRequestId(snapshot.history));
  const [saved, setSaved] = useState(true);
  useEffect(() => {
    if (snapshot.scope !== scope) {
      const history = restore();
      requestRef.current = latestHistoryRequestId(history);
      update({ type: 'scope', snapshot: { scope, history } }); setSaved(true);
      return;
    }
    if (!persist) { setSaved(true); return; }
    try { setSaved(saveScopedHistory(window.localStorage, snapshot.history, namespace, persist)); } catch { setSaved(false); }
  }, [scope, snapshot, namespace, persist]);
  const dispatch = useCallback((event: ConversationEvent) => update({ type: 'event', scope, profile, event }), [scope, profile]);
  return { state: snapshot.scope === scope ? snapshot.history[profile] ?? initialConversation : initialConversation, dispatch, requestRef, saved };
}
