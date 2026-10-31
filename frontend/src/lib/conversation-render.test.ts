import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { conversationReducer as reduce, initialConversation, lastMiuAnswer, lastUserMessage } from './conversation.ts';
import { readConversationHistory, saveConversationHistory } from './conversation-history.ts';
import { voiceUserMessage } from './voice-conversation.ts';

test('the main room and history show the typed sentence together with the buddy reply, including after reload', async () => {
  const server = await createServer({ configFile: 'vite.config.ts', server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { default: Bubble } = await server.ssrLoadModule('/src/components/MiuSpeechBubble.tsx');
    const { default: Messages } = await server.ssrLoadModule('/src/components/ConversationMessages.tsx');
    const t = (key: string) => ({ you: 'You', typedMessage: 'Typed', isThinking: 'Miu is thinking', mutedStatus: 'Miu is ready' }[key] ?? key);
    const user = { id: 51, role: 'user' as const, text: 'Why do cats purr?', source: 'typed' as const };
    let state = reduce(initialConversation, { type: 'think', requestId: user.id, user });
    const room = () => renderToStaticMarkup(createElement(Bubble, { phase: state.phase, user: lastUserMessage(state), answer: lastMiuAnswer(state), greeting: 'Hello', t }));
    assert.ok(room().includes(user.text), 'sent text must remain visible while waiting');
    assert.ok(room().includes('Miu is thinking'));
    const answer = { id: user.id, text: 'Purring can mean a cat feels cozy.', emotion: 'happy' as const, source: 'sample' as const };
    state = reduce(state, { type: 'reply', answer, speaking: true });
    for (const phase of ['speaking', 'answered'] as const) {
      state = { ...state, phase };
      const html = room();
      assert.ok(html.includes(user.text));
      assert.ok(html.includes(answer.text));
      assert.ok(html.indexOf(user.text) < html.indexOf(answer.text));
    }
    let stored = '';
    saveConversationHistory({ setItem: (_key, value) => { stored = value; } }, { an: state });
    state = readConversationHistory({ getItem: () => stored }).an;
    assert.ok(room().includes(user.text));
    assert.ok(room().includes(answer.text));
    const history = renderToStaticMarkup(createElement(Messages, { messages: state.messages, t }));
    assert.equal((history.match(/class="conversation-turn"/g) ?? []).length, 1, 'both speakers share one scroll target');
    assert.ok(history.includes('user-message'));
    assert.ok(history.includes('miu-message'));
    assert.ok(history.indexOf(user.text) < history.indexOf(answer.text));

    state = reduce(state, { type: 'think', requestId: 52, user: { ...user, id: 52, text: 'A different question' } });
    state = reduce(state, { type: 'finish' });
    assert.ok(room().includes('A different question'));
    assert.ok(!room().includes(answer.text), 'an older answer must not be paired with a canceled question');
  } finally { await server.close(); }
});

test('voice progress and reference-demo explanations render consistently in the room and history', async () => {
  const server = await createServer({ configFile: 'vite.config.ts', server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { default: Bubble } = await server.ssrLoadModule('/src/components/MiuSpeechBubble.tsx');
    const { default: Messages } = await server.ssrLoadModule('/src/components/ConversationMessages.tsx');
    const t = (key: string) => ({ you: 'You', spokenMessage: 'Voice', voiceMessageProcessing: 'Sending your voice message', voiceReferenceTranscript: 'Reference demo does not transcribe your speech', voiceTranscriptUnavailable: 'No transcript was returned' }[key] ?? key);
    let state = reduce(initialConversation, { type: 'think', requestId: 60, user: voiceUserMessage(60) });
    const rendered = () => [
      renderToStaticMarkup(createElement(Bubble, { phase: state.phase, user: lastUserMessage(state), answer: lastMiuAnswer(state), pendingRequestId: state.pendingRequestId, greeting: 'Hello', t })),
      renderToStaticMarkup(createElement(Messages, { messages: state.messages, pendingRequestId: state.pendingRequestId, t })),
    ];
    for (const html of rendered()) {
      assert.ok(html.includes('Sending your voice message'));
      assert.ok(!html.includes('No transcript was returned'));
      assert.ok(html.includes('You'));
    }
    const fake = voiceUserMessage(60, { provider_mode: 'fake', transcript: { text: 'Fixture speech', language: 'en', uncertain_spans: [] } });
    state = reduce(state, { type: 'reply', user: fake, answer: { id: 60, text: 'A fixed demo reply', emotion: 'happy', source: 'reference' }, speaking: false });
    for (const html of rendered()) {
      assert.ok(html.includes('Reference demo does not transcribe your speech'));
      assert.ok(!html.includes('No transcript was returned'));
      assert.ok(!html.includes('Fixture speech'));
    }
    let saved = '';
    saveConversationHistory({ setItem: (_key, value) => { saved = value; } }, { an: state });
    state = readConversationHistory({ getItem: () => saved }).an;
    for (const html of rendered()) assert.ok(html.includes('Reference demo does not transcribe your speech'));
  } finally { await server.close(); }
});
