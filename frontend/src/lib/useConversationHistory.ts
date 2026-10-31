import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { initialConversation, type ConversationEvent } from './conversation';
import { historyReducer, latestHistoryRequestId, readConversationHistory, saveConversationHistory } from './conversation-history';

export function useConversationHistory(profile: string) {
  const [history, update] = useReducer(historyReducer, undefined, () => {
    try { return readConversationHistory(window.localStorage); } catch { return {}; }
  });
  const requestRef = useRef(latestHistoryRequestId(history));
  const [saved, setSaved] = useState(true);
  useEffect(() => {
    try { setSaved(saveConversationHistory(window.localStorage, history)); } catch { setSaved(false); }
  }, [history]);
  const dispatch = useCallback((event: ConversationEvent) => update({ profile, event }), [profile]);
  return { state: history[profile] ?? initialConversation, dispatch, requestRef, saved };
}
