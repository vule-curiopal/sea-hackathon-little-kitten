import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import Miu from '../components/Miu';
import Icon from '../components/Icon';
import Room from '../components/Room';
import Dialog from '../components/Dialog';
import DemoShare from '../components/DemoShare';
import MiuPlayground from '../components/MiuPlayground';
import MemoryPanel from '../components/MemoryPanel';
import MiuSpeechBubble from '../components/MiuSpeechBubble';
import ConversationMessages from '../components/ConversationMessages';
import HoldToTalkButton from '../components/HoldToTalkButton';
import { useLanguage, readPreference, savePreference, type TranslationKey } from '../lib/i18n';
import { lastMiuAnswer, lastUserMessage, type UserMessage } from '../lib/conversation';
import { useConversationHistory } from '../lib/useConversationHistory';
import { usePipelineVoice } from '../lib/usePipelineVoice';
import { DEFAULT_VOICE, VOICES, type VoiceControllerState } from '@miu/voice-client';
import { useMiuBehavior } from '../lib/useMiuBehavior';
import { activityEmotion, type CatActivity, type CatReaction } from '../lib/miu-behavior';
import { DEMO_BUDDY, demoLanguage } from '../lib/demo-buddy';
import { PERSONALITIES, type Presentation, type Role } from '../lib/engine-api';
import { emotions, type Emotion } from '../lib/miu-pose';
import { useDailyMood } from '../lib/useDailyMood';
import { dailyEnergy, moodPresentation, spokenMoodText } from '../lib/daily-mood';
import { voiceConversationEvent, voiceUserMessage } from '../lib/voice-conversation';

export default function Talk({ guest = false }: { guest?: boolean }) {
  const { t, language, setLanguage } = useLanguage();
  const [profile, setProfile] = useState(() => readPreference('miu.profile', 'an') === 'binh' ? 'binh' : 'an');
  const { state, dispatch, requestRef, saved: historySaved } = useConversationHistory(profile);
  const [voiceId, setVoiceId] = useState<string>('');
  const [voiceError, setVoiceError] = useState<TranslationKey | null>(null);
  const [sound, setSound] = useState(() => readPreference('miu.sound', 'true') === 'true');
  const [personality, setPersonality] = useState('ENFP');
  const [role, setRole] = useState<Role>('friend');
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [modal, setModal] = useState<'settings' | 'new' | null>(null);
  const [message, setMessage] = useState('');
  const [visible, setVisible] = useState(() => !document.hidden);
  const voiceRequestRef = useRef<number | null>(null);
  const voiceStateRef = useRef<VoiceControllerState>('initializing');
  const turnInputRef = useRef<'audio' | 'text' | 'greeting'>('audio');
  const turnUserRef = useRef<UserMessage | undefined>(undefined);
  const turnRedactedRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const lastAnswer = lastMiuAnswer(state);
  const lastUser = lastUserMessage(state);
  const preset = DEMO_BUDDY.copy[language];
  const resting = state.phase === 'resting';
  const mood = useDailyMood(profile, state.phase);
  const moodRef = useRef(mood);
  moodRef.current = mood;
  const pipeline = usePipelineVoice({ language, profile, voiceId: voiceId || DEFAULT_VOICE[language], personality, role,
    onState: phase => {
      const id = voiceRequestRef.current;
      const event = voiceConversationEvent(voiceStateRef.current, phase, id !== null && id === requestRef.current ? id : undefined, turnInputRef.current);
      voiceStateRef.current = phase;
      if (event?.type === 'finish') voiceRequestRef.current = null;
      if (event) dispatch(event);
    },
    onTurn: response => {
      const id = voiceRequestRef.current;
      if (id === null || id !== requestRef.current) return;
      // Only real transcripts affect mood; fixture words are never saved as user speech.
      const affect = moodRef.current.assess(turnInputRef.current === 'text' ? turnUserRef.current?.text ?? '' : spokenMoodText(response));
      moodRef.current.commit(affect);
      const plan = response.presentation as Presentation | null;
      const expression = plan?.face?.expression ?? plan?.emotion;
      const emotion: Emotion = emotions.includes(expression as Emotion) ? expression as Emotion : affect.emotion;
      const user = turnRedactedRef.current ? undefined : turnInputRef.current === 'audio' ? voiceUserMessage(id, response) : turnUserRef.current;
      dispatch({ type: 'reply', user, answer: { id, text: response.reply.text, emotion, intensity: affect.intensity, source: response.provider_mode === 'fake' ? 'reference' : 'voice' }, speaking: voiceStateRef.current === 'speaking' });
    },
    onInvalidate: () => {
      turnRedactedRef.current = true; turnUserRef.current = undefined;
      dispatch({ type: 'reset' }); setMessage(''); moodRef.current.clearConversation();
      const id = voiceRequestRef.current;
      if (id !== null && id === requestRef.current) dispatch({ type: 'think', requestId: id });
    },
  });
  const presentation = pipeline.lastTurn?.presentation as Presentation | null | undefined;
  const micEnabled = pipeline.state === 'recording';
  const voiceActive = ['recording', 'processing', 'speaking', 'playback_blocked'].includes(pipeline.state);
  const busy = state.phase === 'thinking' || state.phase === 'speaking' || voiceActive || pipeline.advancing;
  const comfort = presentation?.comfortActive === true || mood.turn?.comfort === true;
  const cat = useMiuBehavior({ phase: state.phase, visible, suspended: micEnabled || !!modal || memoryOpen, comfort, energy: dailyEnergy(mood.daily), poutChance: .05 + mood.daily.levels.sulky / 100 });
  const activity = cat.reset;
  const sleeping = cat.activity === 'sleep' || cat.activity === 'doze';
  const canPet = visible && !resting && !busy && state.phase !== 'listening' && !micEnabled && !modal && !memoryOpen;

  useEffect(() => {
    if (!guest) return;
    setLanguage(demoLanguage(window.location.search) ?? DEMO_BUDDY.defaultLanguage);
  }, [guest, setLanguage]);

  const stopPending = useCallback(() => {
    requestRef.current++;
    voiceRequestRef.current = null;
    turnUserRef.current = undefined;
    turnRedactedRef.current = false;
  }, []);
  useEffect(() => {
    const hide = () => {
      setVisible(!document.hidden);
      if (document.hidden) { stopPending(); dispatch({ type: 'finish' }); }
    };
    document.addEventListener('visibilitychange', hide);
    activity();
    return () => { document.removeEventListener('visibilitychange', hide); stopPending(); };
  }, [activity, stopPending, dispatch]);
  useEffect(() => { savePreference('miu.sound', String(sound)); }, [sound]);
  useEffect(() => { savePreference('miu.profile', profile); }, [profile]);
  useEffect(() => {
    if (!panelOpen) return;
    const log = messagesRef.current;
    const turn = log?.querySelector<HTMLElement>('.conversation-turn:last-of-type');
    if (!log || !turn) return;
    // Keep the user's sentence in view instead of jumping past it to the reply.
    const top = turn.getBoundingClientRect().top - log.getBoundingClientRect().top + log.scrollTop;
    log.scrollTo({ top: Math.max(0, top - 8), behavior: 'auto' });
  }, [state.messages, panelOpen]);
  useEffect(() => {
    if (!lastAnswer || panelOpen || !visible) return;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    bubbleRef.current?.scrollIntoView({ block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' });
  }, [lastAnswer?.id, panelOpen, visible]);
  useEffect(() => {
    if (!panelOpen) return;
    const previousFocus = document.activeElement as HTMLElement;
    const media = window.matchMedia('(min-width: 900px)');
    const previousOverflow = document.body.style.overflow;
    const updateOverflow = () => { document.body.style.overflow = media.matches ? previousOverflow : 'hidden'; };
    updateOverflow();
    media.addEventListener('change', updateOverflow);
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setPanelOpen(false); return; }
      if (event.key !== 'Tab' || media.matches) return;
      const items = panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), a[href]');
      if (!items?.length) return;
      const first = items[0]; const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); media.removeEventListener('change', updateOverflow); document.body.style.overflow = previousOverflow; previousFocus?.focus(); };
  }, [panelOpen]);

  const answer = useCallback((text: string) => {
    if (!text.trim() || resting || busy || !pipeline.session) return;
    activity();
    stopPending();
    const id = requestRef.current;
    voiceRequestRef.current = id; turnInputRef.current = 'text';
    const user: UserMessage = { id, role: 'user', text: text.trim(), source: 'typed' };
    turnUserRef.current = user;
    dispatch({ type: 'think', requestId: id, user });
    if (!pipeline.text(text, !sound)) { voiceRequestRef.current = null; dispatch({ type: 'finish', requestId: id }); }
  }, [resting, busy, sound, activity, stopPending, pipeline.text, pipeline.session, dispatch]);
  function greet() {
    if (resting || busy || !pipeline.session) return;
    activity(); stopPending();
    const id = requestRef.current;
    voiceRequestRef.current = id; turnInputRef.current = 'greeting';
    dispatch({ type: 'think', requestId: id });
    if (!pipeline.greet(!sound)) { voiceRequestRef.current = null; dispatch({ type: 'finish', requestId: id }); }
  }
  function stopConversation() {
    stopPending(); void pipeline.stop(); dispatch({ type: 'finish' });
  }
  function changeLanguage(next: 'en' | 'vi') {
    stopConversation(); mood.clearConversation(); setVoiceId(''); setLanguage(next); setVoiceError(null);
  }

  function openPanel(focusInput = false) {
    setPanelOpen(true); activity();
    if (focusInput && voiceActive) stopConversation();
    requestAnimationFrame(() => { if (focusInput) inputRef.current?.focus(); else panelRef.current?.querySelector<HTMLButtonElement>('button')?.focus(); });
  }
  function startVoice(): boolean {
    activity();
    if (pipeline.state === 'playback_blocked') { pipeline.play(); return false; }
    if (micEnabled) return false;
    if (pipeline.state === 'processing' || state.phase === 'speaking' || state.phase === 'thinking') { stopConversation(); return false; }
    if (!pipeline.session) { pipeline.reconnect(); return false; }
    if (!window.isSecureContext) { setVoiceError('voiceSecure'); openPanel(true); return false; }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { setVoiceError('voiceMissing'); openPanel(true); return false; }
    if (resting) wake();
    stopPending(); voiceRequestRef.current = requestRef.current; turnInputRef.current = 'audio';
    dispatch({ type: 'finish' }); setVoiceError(null);
    const started = pipeline.talk();
    if (!started) voiceRequestRef.current = null;
    return started;
  }
  function pause() {
    stopConversation(); activity(); setModal(null); dispatch({ type: 'pause' });
  }
  function wake() {
    dispatch({ type: 'wake' }); setModal(null); cat.react('wake');
  }
  function interact(reaction: CatReaction) {
    if (!canPet) return;
    if (comfort && ['purr', 'tickle', 'play', 'snack'].includes(reaction)) { cat.react('cuddle'); return; }
    cat.react(reaction);
  }
  function submit(event: FormEvent) { event.preventDefault(); if (!message.trim() || busy || resting) return; answer(message); setMessage(''); }
  const silentReply = pipeline.state === 'playback_blocked' && pipeline.lastTurn?.audio === null;
  const micLabel: TranslationKey = pipeline.state === 'initializing' ? 'voiceConnecting' : pipeline.state === 'playback_blocked' ? silentReply ? 'doneReading' : 'voicePlay' : micEnabled ? 'voiceRelease' : busy ? 'voiceStop' : !pipeline.session ? 'voiceConnect' : 'voiceTalk';
  const status: TranslationKey = resting ? 'restingTitle' : pipeline.state === 'playback_blocked' ? silentReply ? 'textReady' : 'voiceBlocked' : state.phase === 'listening' ? pipeline.capture === 'requesting_permission' ? 'voicePermission' : pipeline.capture === 'finalizing_capture' ? 'voiceMessageProcessing' : pipeline.capture === 'calibrating' ? 'voiceCalibrating' : 'isListening' : state.phase === 'thinking' ? 'isThinking' : state.phase === 'speaking' ? 'isSpeaking' : 'mutedStatus';
  const ambient = state.phase === 'answered' && !voiceActive && !modal && !memoryOpen;
  const voiceNotice = voiceError ?? pipeline.error;
  const voiceMode: TranslationKey = !pipeline.session ? 'voiceService' : pipeline.session.provider_mode === 'fake' ? 'voiceReference' : 'voiceLive';
  const feeling = moodPresentation(mood.daily, mood.turn, state.phase, cat.activity, activityEmotion(cat.activity));
  const emotion = resting || sleeping ? 'sleepy' : state.phase === 'listening' || state.phase === 'thinking' ? state.phase : comfort ? 'neutral' : pipeline.session?.engine_mode === 'character_memory' && lastAnswer && (cat.activity === 'settled' || state.phase === 'speaking') ? lastAnswer.emotion : feeling.emotion;
  const activityLabels: Record<CatActivity, TranslationKey> = { settled: 'catSettled', look: 'catLook', ears: 'catEars', groom: 'catGroom', stretch: 'catStretch', play: 'catPlay', pout: 'catPout', doze: 'catDoze', sleep: 'catSleep', wake: 'catWake', purr: 'catPurr', boop: 'catBoop', tickle: 'catTickle', highfive: 'catHighFive', cuddle: 'catCuddle', snack: 'catSnack' };
  const characterDescription = resting || sleeping ? t('touchWakeHint') : ambient ? t(activityLabels[cat.activity]) : '';

  return <main id="main-content" className="talk-page" onPointerDown={event => { if (!(event.target as Element).closest('.cat-companion')) activity(); }} onKeyDown={event => { if (!(event.target as Element).closest('.cat-companion')) activity(); }}>
    <div className="demo-banner"><span><span className="small-dot" />{t(voiceMode)}</span><p>{t(!pipeline.session ? 'voiceServiceHint' : pipeline.session.provider_mode === 'fake' ? 'voiceReferenceHint' : 'voiceLiveHint')}</p></div>
    <div className={`talk-layout ${panelOpen ? 'panel-is-open' : ''}`}>
      <Room className={`talk-room ${resting ? 'is-resting' : sleeping ? 'is-dozing' : ''}`}>
        <header className="talk-header"><a className="round-button" href="/" aria-label={t('back')}><Icon name="back" /></a><div className="miu-nameplate"><span className={`presence-dot ${resting || sleeping ? 'is-resting' : ''}`} /><h1>Miu</h1><span>{t(resting ? 'resting' : sleeping ? 'catDozing' : 'awake')}</span></div><button className="round-button" aria-label={t('settings')} onClick={() => { stopConversation(); setModal('settings'); }}><Icon name="settings" /></button></header>
        <DemoShare />
        <div className="talk-scene">
          <div className="scene-actions"><button className="round-button" aria-label={t('talkLang')} title={t('talkLang')} onClick={() => changeLanguage(language === 'en' ? 'vi' : 'en')}>{language === 'en' ? 'EN' : 'VI'}</button><button className="round-button" aria-label={t('newConversation')} title={t('newConversation')} onClick={() => { stopConversation(); setModal('new'); }}><Icon name="refresh" /></button><button className="round-button" aria-label={t(resting ? 'wake' : 'pause')} title={t(resting ? 'wake' : 'pause')} onClick={() => resting ? wake() : pause()}><Icon name={resting ? 'play' : 'pause'} /></button></div>
          {resting ? <div className="rest-card"><Icon name="moon" /><h2>{t('restingTitle')}</h2><p>{t('restingBody')}</p><button className="button button-primary" onClick={wake}>{t('wake')}<Icon name="play" /></button></div> : <MiuSpeechBubble phase={state.phase} answer={lastAnswer} user={lastUser} pendingRequestId={state.pendingRequestId} greeting={t('readyPrompt')} listeningLabel={status} bubbleRef={bubbleRef} t={t} />}
          <MiuPlayground emotion={emotion} intensity={feeling.intensity} activity={cat.activity} alive={visible && !sleeping && !resting} speaking={state.phase === 'speaking'} mouthLevel={pipeline.mouthLevel} comfort={comfort} canInteract={canPet} resting={resting} sleeping={sleeping} label={`${t('characterLabel')}${characterDescription ? ` · ${characterDescription}` : ''}`} t={t} onReact={interact} onWake={wake} onCancel={activity} />
        </div>
        <div className={`talk-status phase-${state.phase}`} role={ambient ? undefined : 'status'}><span>{ambient ? t(activityLabels[cat.activity]) : t(status)}</span></div>
        <div className="talk-controls">
          {voiceActive && <button className="voice-stop" onClick={stopConversation}><Icon name="stop" />{t('voiceStop')}</button>}
          <HoldToTalkButton className={`microphone-button ${micEnabled ? 'is-enabled' : ''} ${state.phase === 'listening' ? 'is-listening' : ''}`} label={t(micLabel)} recording={micEnabled} disabled={pipeline.state === 'initializing'} icon={pipeline.state === 'playback_blocked' ? silentReply ? 'heart' : 'play' : busy && !micEnabled ? 'stop' : 'mic'} text={micEnabled ? t('voiceReleaseShort') : !busy && pipeline.state !== 'initializing' ? t('talkButton') : undefined} onStart={startVoice} onSend={pipeline.send} onCancel={stopConversation} />
          <button className="round-button" aria-label={t('conversation')} aria-expanded={panelOpen} aria-controls="conversation-panel" onClick={() => panelOpen ? setPanelOpen(false) : openPanel()}><Icon name="chat" /></button>
        </div>
        <p className="mic-hint">{t(resting ? 'restingNote' : micEnabled ? pipeline.manualOnly ? 'voiceManual' : 'voiceCaptureHint' : busy || !pipeline.session ? micLabel : 'micHint')}</p>
        {micEnabled && pipeline.meter && <div className="voice-meter"><meter min={-80} max={0} value={pipeline.meter.levelDbfs} aria-label={t('voiceLevel')} /><span>{Math.floor(pipeline.meter.elapsedMs / 1000)} / 30 s</span></div>}
        {pipeline.state === 'playback_blocked' && <button className="button button-primary voice-play" onClick={pipeline.play}><Icon name={silentReply ? 'heart' : 'play'} />{t(silentReply ? 'doneReading' : 'voicePlay')}</button>}
        {voiceNotice && <div className="voice-notice" role="status"><span>{t(voiceNotice)}</span><button aria-label={t('close')} onClick={() => { setVoiceError(null); pipeline.clearError(); }}><Icon name="close" /></button></div>}
        <div className="room-secondary-actions"><button disabled={!pipeline.session || busy || resting || !!pipeline.lastTurn} onClick={greet}>{t('sayHello')}</button><span aria-hidden="true">·</span><button onClick={() => { stopConversation(); setMemoryOpen(true); }}>{t('adultDemo')}</button></div>
        <p className="talk-footer">{t('talkFooter')}</p>
      </Room>
      {panelOpen && <button className="panel-backdrop" tabIndex={-1} aria-label={t('close')} onClick={() => setPanelOpen(false)} />}
      <aside id="conversation-panel" ref={panelRef} className={`conversation-panel ${panelOpen ? 'is-open' : ''}`} aria-label={t('conversation')} inert={!panelOpen}>
        <div className="panel-heading"><div><span className="eyebrow">Miu</span><h2>{t('conversation')}</h2></div><div className="panel-heading-actions">{busy && <button className="round-button" onClick={stopConversation} aria-label={t('voiceStop')}><Icon name="stop" /></button>}<button className="round-button" onClick={() => setPanelOpen(false)} aria-label={t('close')}><Icon name="close" /></button></div></div>
        <p className="conversation-note" role={historySaved ? undefined : 'status'}><Icon name="lock" />{t(historySaved ? 'voiceConversationNote' : 'conversationSaveUnavailable')}</p>
        <p className="conversation-note">{t('voiceTextDemo')}</p>
        <div className="answers" ref={messagesRef} role="log" aria-live="polite">{state.messages.length ? <ConversationMessages messages={state.messages} pendingRequestId={state.pendingRequestId} t={t} /> : <div className="conversation-empty"><Miu emotion="curious" /><p>{t('emptyConversation')}</p><div className="demo-starters" aria-label={t('tryQuestion')}>{preset.starters.map(starter => <button key={starter} onClick={() => answer(starter)} disabled={resting || busy || !pipeline.session}>{starter}<Icon name="arrow" /></button>)}</div></div>}{state.phase === 'thinking' && <p className="thinking-label">{t('isThinking')}</p>}</div>
        <form className="message-form" onSubmit={submit}><label className="sr-only" htmlFor="message">{t('typeMessage')}</label><div className="message-input"><textarea ref={inputRef} id="message" rows={2} maxLength={500} placeholder={t('messagePlaceholder')} value={message} onChange={event => setMessage(event.target.value)} disabled={resting || busy || !pipeline.session} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (message.trim()) { answer(message); setMessage(''); } } }} /><button className="button button-primary" type="submit" aria-label={t('send')} disabled={!message.trim() || resting || busy || !pipeline.session}><Icon name="arrow" /></button></div><span className="message-limit">{message.length}/500</span></form>
      </aside>
    </div>
    <Dialog open={modal === 'settings'} onClose={() => setModal(null)} title={t('settings')}>
      <div className="settings-avatar"><Miu emotion="happy" /><span>Miu</span></div>
      <p className="settings-note">{t('voiceEngineHint')}</p>
      <fieldset className="language-setting"><legend>{t('talkLang')}</legend><p>{t('languageHint')}</p><div className="segmented-control">{(['en', 'vi'] as const).map(lang => <button key={lang} className={language === lang ? 'is-selected' : ''} aria-pressed={language === lang} onClick={() => changeLanguage(lang)}>{t(lang === 'en' ? 'english' : 'vietnamese')}</button>)}</div></fieldset>
      <div className="voice-settings">
        <label htmlFor="voice-profile">{t('voiceProfile')}</label><select id="voice-profile" value={profile} onChange={event => { stopConversation(); setMessage(''); setProfile(event.target.value); }}><option value="an">An</option><option value="binh">Bình</option></select>
        <p>{t('voiceProfileHint')}</p>
        <label htmlFor="voice-choice">{t('voiceChoice')}</label><select id="voice-choice" value={voiceId || DEFAULT_VOICE[language]} onChange={event => { stopConversation(); setVoiceId(event.target.value); mood.clearConversation(); }}>{VOICES.filter(voice => voice.language === language).map(voice => <option key={voice.id} value={voice.id}>{voice.label}</option>)}</select>
        <p>{t(pipeline.session?.provider_mode === 'fake' ? 'voiceFixtureChoice' : 'voiceChoiceHint')}</p>
        <label htmlFor="personality-choice">{t('personalityChoice')}</label><select id="personality-choice" value={personality} onChange={event => { stopConversation(); mood.clearConversation(); setPersonality(event.target.value); }}>{PERSONALITIES.map(preset => <option key={preset} value={preset}>{preset}</option>)}</select><p>{t('personalityHint')}</p>
        <label htmlFor="role-choice">{t('roleChoice')}</label><select id="role-choice" value={role} onChange={event => { stopConversation(); mood.clearConversation(); setRole(event.target.value as Role); }}><option value="friend">{t('friendRole')}</option><option value="big_sibling">{t('siblingRole')}</option><option value="teacher">{t('teacherRole')}</option></select>
        <button className="button button-white" onClick={() => { stopConversation(); mood.clearConversation(); pipeline.reconnect(); }}>{t('voiceReconnect')}</button>
      </div>
      <div className="setting-row"><div><label htmlFor="sound">{t('sound')}</label><p>{t('voiceSampleSound')}</p></div><input id="sound" className="switch" type="checkbox" checked={sound} onChange={event => { stopConversation(); setSound(event.target.checked); }} /></div>
      <button className="button button-white adult-settings-link" onClick={() => { setModal(null); setMemoryOpen(true); }}>{t('adultDemo')}<Icon name="arrow" /></button>
      <button className="button button-white settings-pause" onClick={() => { if (resting) wake(); else pause(); }}><Icon name={resting ? 'play' : 'pause'} />{t(resting ? 'wake' : 'pause')}</button><button className="button button-primary dialog-done" onClick={() => setModal(null)}>{t('done')}</button>
    </Dialog>
    <Dialog open={modal === 'new'} onClose={() => setModal(null)} title={t('newTitle')}><p className="dialog-body">{t('newBody')}</p><div className="dialog-actions"><button className="button button-white" onClick={() => setModal(null)}>{t('cancel')}</button><button className="button button-primary" onClick={() => { stopConversation(); mood.clearConversation(); pipeline.reconnect(); setMessage(''); setVoiceError(null); dispatch({ type: 'reset' }); setModal(null); activity(); }}>{t('newConfirm')}</button></div></Dialog>
    <MemoryPanel open={memoryOpen} onClose={() => setMemoryOpen(false)} session={pipeline.session} revision={pipeline.revision} busy={busy || pipeline.state === 'initializing'} advancing={pipeline.advancing} onNextDay={version => { void pipeline.nextDay(version); }} lastTurn={pipeline.lastTurn} />
  </main>;
}
