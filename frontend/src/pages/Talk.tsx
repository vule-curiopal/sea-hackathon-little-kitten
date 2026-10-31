import { useCallback, useEffect, useReducer, useRef, useState, type FormEvent } from 'react';
import Miu from '../components/Miu';
import Icon from '../components/Icon';
import Room from '../components/Room';
import Dialog from '../components/Dialog';
import DemoShare from '../components/DemoShare';
import MiuPlayground from '../components/MiuPlayground';
import { useLanguage, readPreference, savePreference, type TranslationKey } from '../lib/i18n';
import { conversationReducer, initialConversation } from '../lib/conversation';
import { getDemoReply } from '../lib/demo';
import { usePipelineVoice } from '../lib/usePipelineVoice';
import { DEFAULT_VOICE, VOICES } from '@miu/voice-client';
import { useMiuBehavior } from '../lib/useMiuBehavior';
import { activityEmotion, type CatActivity, type CatReaction } from '../lib/miu-behavior';
import { DEMO_BUDDY, demoLanguage } from '../lib/demo-buddy';

export default function Talk({ guest = false }: { guest?: boolean }) {
  const { t, language, setLanguage } = useLanguage();
  const [state, dispatch] = useReducer(conversationReducer, initialConversation);
  const [profile, setProfile] = useState('an');
  const [voiceId, setVoiceId] = useState<string>('');
  const [voiceError, setVoiceError] = useState<TranslationKey | null>(null);
  const [sound, setSound] = useState(() => readPreference('miu.sound', String(DEMO_BUDDY.readAloudByDefault)) === 'true');
  const [panelOpen, setPanelOpen] = useState(false);
  const [modal, setModal] = useState<'settings' | 'new' | null>(null);
  const [message, setMessage] = useState('');
  const [visible, setVisible] = useState(() => !document.hidden);
  const requestRef = useRef(0);
  const replyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const speechTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const lastAnswer = state.answers.at(-1);
  const preset = DEMO_BUDDY.copy[language];
  const resting = state.phase === 'resting';
  const pipeline = usePipelineVoice({ language, profile, voiceId: voiceId || DEFAULT_VOICE[language],
    onState: phase => {
      if (phase === 'recording') dispatch({ type: 'listen' });
      else if (phase === 'processing') dispatch({ type: 'think' });
      else if (phase === 'speaking') dispatch({ type: 'speak' });
      else if (phase === 'idle' || phase === 'error') dispatch({ type: 'finish' });
    },
    onTurn: response => dispatch({ type: 'reply', answer: { id: ++requestRef.current, text: response.reply.text, emotion: 'neutral', source: response.provider_mode === 'fake' ? 'reference' : 'voice' }, speaking: false }),
  });
  const micEnabled = pipeline.state === 'recording';
  const voiceActive = ['recording', 'processing', 'speaking', 'playback_blocked'].includes(pipeline.state);
  const busy = state.phase === 'thinking' || state.phase === 'speaking' || voiceActive;
  const cat = useMiuBehavior({ phase: state.phase, visible, suspended: micEnabled || !!modal, comfort: state.emotion === 'sad' });
  const activity = cat.reset;
  const sleeping = cat.activity === 'sleep' || cat.activity === 'doze';
  const canPet = visible && !resting && !busy && state.phase !== 'listening' && !micEnabled && !modal;

  useEffect(() => {
    if (!guest) return;
    setLanguage(demoLanguage(window.location.search) ?? DEMO_BUDDY.defaultLanguage);
  }, [guest, setLanguage]);

  const stopPending = useCallback(() => {
    requestRef.current++;
    clearTimeout(replyTimer.current); clearTimeout(speechTimer.current);
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  }, []);
  useEffect(() => {
    const hide = () => {
      setVisible(!document.hidden);
      if (document.hidden) { stopPending(); dispatch({ type: 'finish' }); }
    };
    document.addEventListener('visibilitychange', hide);
    activity();
    return () => { document.removeEventListener('visibilitychange', hide); stopPending(); };
  }, [activity, stopPending]);
  useEffect(() => { savePreference('miu.sound', String(sound)); }, [sound]);
  useEffect(() => { messagesRef.current?.scrollTo({ top: messagesRef.current.scrollHeight, behavior: 'auto' }); }, [state.answers, panelOpen]);
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
    if (!text.trim() || resting || busy) return;
    activity();
    stopPending();
    const id = requestRef.current;
    dispatch({ type: 'think' });
    const reply = getDemoReply(text, language);
    replyTimer.current = setTimeout(() => {
      if (id !== requestRef.current) return;
      const canSpeak = sound && 'speechSynthesis' in window;
      dispatch({ type: 'reply', answer: { id, ...reply, source: 'sample' }, speaking: canSpeak });
      if (canSpeak) {
        const speech = new SpeechSynthesisUtterance(reply.text);
        speech.lang = language === 'vi' ? 'vi-VN' : 'en-US';
        speech.rate = DEMO_BUDDY.speech.rate; speech.pitch = DEMO_BUDDY.speech.pitch;
        const voice = window.speechSynthesis.getVoices().find(v => v.lang.toLowerCase().startsWith(language));
        if (voice) speech.voice = voice;
        const finish = () => { if (id === requestRef.current) { clearTimeout(speechTimer.current); dispatch({ type: 'finish' }); } };
        speech.onend = finish; speech.onerror = finish;
        window.speechSynthesis.speak(speech);
        speechTimer.current = setTimeout(() => { window.speechSynthesis.cancel(); finish(); }, 20000);
      }
    }, 750);
  }, [resting, busy, language, sound, activity, stopPending]);
  function stopConversation() {
    stopPending(); void pipeline.stop(); dispatch({ type: 'finish' });
  }
  function changeLanguage(next: 'en' | 'vi') {
    stopConversation(); setVoiceId(''); setLanguage(next); setVoiceError(null); dispatch({ type: 'reset' });
  }

  function openPanel(focusInput = false) {
    setPanelOpen(true); stopConversation(); activity();
    requestAnimationFrame(() => { if (focusInput) inputRef.current?.focus(); else panelRef.current?.querySelector<HTMLButtonElement>('button')?.focus(); });
  }
  function toggleMic() {
    activity();
    if (pipeline.state === 'playback_blocked') { pipeline.play(); return; }
    if (micEnabled) { pipeline.send(); return; }
    if (pipeline.state === 'processing' || state.phase === 'speaking' || state.phase === 'thinking') { stopConversation(); return; }
    if (!pipeline.session) { pipeline.reconnect(); return; }
    if (!window.isSecureContext) { setVoiceError('voiceSecure'); openPanel(true); return; }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { setVoiceError('voiceMissing'); openPanel(true); return; }
    if (resting) wake();
    stopPending(); dispatch({ type: 'finish' }); setVoiceError(null); pipeline.talk();
  }
  function pause() {
    stopConversation(); activity(); setModal(null); dispatch({ type: 'pause' });
  }
  function wake() {
    dispatch({ type: 'wake' }); setModal(null); cat.react('wake');
  }
  function interact(reaction: CatReaction) {
    if (!canPet) return;
    cat.react(reaction);
  }
  function submit(event: FormEvent) { event.preventDefault(); if (!message.trim() || busy || resting) return; answer(message); setMessage(''); }
  const micLabel: TranslationKey = pipeline.state === 'initializing' ? 'voiceConnecting' : pipeline.state === 'playback_blocked' ? 'voicePlay' : micEnabled ? 'sendNow' : busy ? 'voiceStop' : !pipeline.session ? 'voiceConnect' : 'voiceTalk';
  const status: TranslationKey = resting ? 'restingTitle' : pipeline.state === 'playback_blocked' ? 'voiceBlocked' : state.phase === 'listening' ? pipeline.capture === 'requesting_permission' ? 'voicePermission' : pipeline.capture === 'calibrating' ? 'voiceCalibrating' : 'isListening' : state.phase === 'thinking' ? 'isThinking' : state.phase === 'speaking' ? 'isSpeaking' : 'mutedStatus';
  const ambient = state.phase === 'answered' && !voiceActive && !modal;
  const voiceNotice = voiceError ?? pipeline.error;
  const voiceMode: TranslationKey = !pipeline.session ? 'voiceService' : pipeline.session.provider_mode === 'fake' ? 'voiceReference' : 'voiceLive';
  const emotion = resting ? 'sleepy' : ambient ? (cat.activity === 'settled' && lastAnswer ? state.emotion : activityEmotion(cat.activity)) : state.emotion;
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
          {resting ? <div className="rest-card"><Icon name="moon" /><h2>{t('restingTitle')}</h2><p>{t('restingBody')}</p><button className="button button-primary" onClick={wake}>{t('wake')}<Icon name="play" /></button></div> : <div className={`talk-bubble ${state.phase === 'thinking' || state.phase === 'listening' ? 'is-quiet' : ''}`} aria-live="polite"><span className="speech-byline">Miu <span className="tiny-dot" />{t(lastAnswer?.source === 'voice' ? 'voiceLive' : lastAnswer?.source === 'reference' ? 'voiceReference' : 'demo')}</span><p>{state.phase === 'thinking' ? t('isThinking') : state.phase === 'listening' ? t(status) : lastAnswer?.text ?? preset.greeting}</p><span className="speech-tail" /></div>}
          <MiuPlayground emotion={emotion} activity={cat.activity} alive={visible && !sleeping && !resting} speaking={state.phase === 'speaking'} canInteract={canPet} resting={resting} sleeping={sleeping} label={`${t('characterLabel')}${characterDescription ? ` · ${characterDescription}` : ''}`} t={t} onReact={interact} onWake={wake} onCancel={activity} />
        </div>
        <div className={`talk-status phase-${state.phase}`} role={ambient ? undefined : 'status'}><span>{ambient ? t(activityLabels[cat.activity]) : t(status)}</span></div>
        <div className="talk-controls">
          {voiceActive && <button className="voice-stop" onClick={stopConversation}><Icon name="stop" />{t('voiceStop')}</button>}
          <button className={`microphone-button ${micEnabled ? 'is-enabled' : ''} ${state.phase === 'listening' ? 'is-listening' : ''}`} aria-label={t(micLabel)} disabled={pipeline.state === 'initializing'} onClick={toggleMic}><Icon name={pipeline.state === 'playback_blocked' ? 'play' : micEnabled ? 'arrow' : busy ? 'stop' : 'mic'} /></button>
          <button className="round-button" aria-label={t('conversation')} aria-expanded={panelOpen} aria-controls="conversation-panel" onClick={() => panelOpen ? setPanelOpen(false) : openPanel()}><Icon name="chat" /></button>
        </div>
        <p className="mic-hint">{t(resting ? 'restingNote' : micEnabled ? pipeline.manualOnly ? 'voiceManual' : 'voiceCaptureHint' : micLabel)}</p>
        {micEnabled && pipeline.meter && <div className="voice-meter"><meter min={-80} max={0} value={pipeline.meter.levelDbfs} aria-label={t('voiceLevel')} /><span>{Math.floor(pipeline.meter.elapsedMs / 1000)} / 30 s</span></div>}
        {pipeline.state === 'playback_blocked' && <button className="button button-primary voice-play" onClick={pipeline.play}><Icon name="play" />{t('voicePlay')}</button>}
        {voiceNotice && <div className="voice-notice" role="status"><span>{t(voiceNotice)}</span><button aria-label={t('close')} onClick={() => { setVoiceError(null); pipeline.clearError(); }}><Icon name="close" /></button></div>}
        <p className="talk-footer">{t('talkFooter')}</p>
      </Room>
      {panelOpen && <button className="panel-backdrop" tabIndex={-1} aria-label={t('close')} onClick={() => setPanelOpen(false)} />}
      <aside id="conversation-panel" ref={panelRef} className={`conversation-panel ${panelOpen ? 'is-open' : ''}`} aria-label={t('conversation')} inert={!panelOpen}>
        <div className="panel-heading"><div><span className="eyebrow">Miu</span><h2>{t('conversation')}</h2></div><button className="round-button" onClick={() => setPanelOpen(false)} aria-label={t('close')}><Icon name="close" /></button></div>
        <p className="conversation-note"><Icon name="lock" />{t('voiceConversationNote')}</p>
        <p className="conversation-note">{t('voiceTextDemo')}</p>
        <div className="answers" ref={messagesRef} role="log" aria-live="polite">{state.answers.length ? state.answers.map(item => <article className="answer" key={item.id}><span className="answer-avatar"><Miu emotion={item.emotion} /></span><div><span>Miu · {t(item.source === 'voice' ? 'voiceLive' : item.source === 'reference' ? 'voiceReference' : 'demo')}</span><p>{item.text}</p></div></article>) : <div className="conversation-empty"><Miu emotion="curious" /><p>{t('emptyConversation')}</p><div className="demo-starters" aria-label={t('tryQuestion')}>{preset.starters.map(starter => <button key={starter} onClick={() => answer(starter)} disabled={resting || busy}>{starter}<Icon name="arrow" /></button>)}</div></div>}{state.phase === 'thinking' && <p className="thinking-label">{t('isThinking')}</p>}</div>
        <form className="message-form" onSubmit={submit}><label className="sr-only" htmlFor="message">{t('typeMessage')}</label><div className="message-input"><textarea ref={inputRef} id="message" rows={2} maxLength={500} placeholder={t('messagePlaceholder')} value={message} onChange={event => setMessage(event.target.value)} disabled={resting || busy} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (message.trim()) { answer(message); setMessage(''); } } }} /><button className="button button-primary" type="submit" aria-label={t('send')} disabled={!message.trim() || resting || busy}><Icon name="arrow" /></button></div><span className="message-limit">{message.length}/500</span></form>
      </aside>
    </div>
    <Dialog open={modal === 'settings'} onClose={() => setModal(null)} title={t('settings')}>
      <div className="settings-avatar"><Miu emotion="happy" /><span>Miu</span></div>
      <p className="settings-note">{t('voiceEngineHint')}</p>
      <fieldset className="language-setting"><legend>{t('talkLang')}</legend><p>{t('languageHint')}</p><div className="segmented-control">{(['en', 'vi'] as const).map(lang => <button key={lang} className={language === lang ? 'is-selected' : ''} aria-pressed={language === lang} onClick={() => changeLanguage(lang)}>{t(lang === 'en' ? 'english' : 'vietnamese')}</button>)}</div></fieldset>
      <div className="voice-settings">
        <label htmlFor="voice-profile">{t('voiceProfile')}</label><select id="voice-profile" value={profile} onChange={event => { stopConversation(); setProfile(event.target.value); dispatch({ type: 'reset' }); }}><option value="an">An</option><option value="binh">Bình</option></select>
        <p>{t('voiceProfileHint')}</p>
        <label htmlFor="voice-choice">{t('voiceChoice')}</label><select id="voice-choice" value={voiceId || DEFAULT_VOICE[language]} onChange={event => { stopConversation(); setVoiceId(event.target.value); dispatch({ type: 'reset' }); }}>{VOICES.filter(voice => voice.language === language).map(voice => <option key={voice.id} value={voice.id}>{voice.label}</option>)}</select>
        <p>{t(pipeline.session?.provider_mode === 'fake' ? 'voiceFixtureChoice' : 'voiceChoiceHint')}</p>
        <button className="button button-white" onClick={() => { stopConversation(); pipeline.reconnect(); dispatch({ type: 'reset' }); }}>{t('voiceReconnect')}</button>
      </div>
      <div className="setting-row"><div><label htmlFor="sound">{t('sound')}</label><p>{t('voiceSampleSound')}</p></div><input id="sound" className="switch" type="checkbox" checked={sound} disabled={!('speechSynthesis' in window)} onChange={event => { setSound(event.target.checked); if (!event.target.checked) { stopPending(); dispatch({ type: 'finish' }); } }} /></div>
      <button className="button button-white settings-pause" onClick={() => { if (resting) wake(); else pause(); }}><Icon name={resting ? 'play' : 'pause'} />{t(resting ? 'wake' : 'pause')}</button><button className="button button-primary dialog-done" onClick={() => setModal(null)}>{t('done')}</button>
    </Dialog>
    <Dialog open={modal === 'new'} onClose={() => setModal(null)} title={t('newTitle')}><p className="dialog-body">{t('newBody')}</p><div className="dialog-actions"><button className="button button-white" onClick={() => setModal(null)}>{t('cancel')}</button><button className="button button-primary" onClick={() => { stopConversation(); pipeline.reconnect(); setMessage(''); setVoiceError(null); dispatch({ type: 'reset' }); setModal(null); activity(); }}>{t('newConfirm')}</button></div></Dialog>
  </main>;
}
