import { useCallback, useEffect, useRef, useState, type ChangeEvent, type PointerEvent } from 'react';
import Dialog from '../components/Dialog';
import Icon from '../components/Icon';
import Room from '../components/Room';
import PresentationShare from '../components/PresentationShare';
import PresentationNotes, { notesLabels, type NotesLanguage } from '../components/PresentationNotes';
import sourceDeck from './slide/Meet Miu.pptx?url';
import '../styles/presentation.css';

const demoVideoId = 'yMPZn1eiUbA';
const demoWatchUrl = `https://www.youtube.com/watch?v=${demoVideoId}`;
const demoEmbedUrl = `https://www.youtube-nocookie.com/embed/${demoVideoId}?rel=0&playsinline=1`;
const notesLanguageKey = 'miu.presentation.notes-language';

function initialNotesLanguage(): NotesLanguage {
  try { return window.localStorage.getItem(notesLanguageKey) === 'en' ? 'en' : 'vi'; }
  catch { return 'vi'; }
}

const slides = [
  { title: 'Small stories deserve a familiar friend', label: 'Why Miu', theme: 'why' },
  { title: 'Meet Miu', label: 'Personality, emotion, memory & growing', theme: 'features' },
  { title: 'Miu in action', label: 'Video demo', theme: 'demo' },
  { title: 'A more natural Miu', label: 'Future improvements', theme: 'future' },
] as const;

const features = [
  { title: 'Personality', description: '16 styles.\nOne familiar Miu.', image: 'miu-personality.png' },
  { title: 'Emotion', description: 'Expressive reactions.\nA mood for the day.', image: 'miu-emotion.png' },
  { title: 'Memory', description: 'Shared details.\nNatural follow-ups.', image: 'miu-memory.png' },
  { title: 'Growing', description: 'A friendship built on\nshared experiences.', image: 'miu-excited.png' },
];

const improvements = [
  { title: 'Voice', description: 'Clearer Vietnamese. Faster replies.\nCute, child-friendly voices and tones.' },
  { title: 'Robot companion', description: 'A cat-shaped robot with an LCD face\nthat shows Miu’s emotions.' },
  { title: 'Smart TV app', description: 'Webcam or camera + built-in mic.\nA virtual play space for more\ninteraction between children and Miu.' },
];

function initialSlide() {
  const match = /^#slide-([1-4])$/.exec(window.location.hash);
  return match ? Number(match[1]) - 1 : 0;
}

function ExpandIcon({ expanded }: { expanded: boolean }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={expanded ? 'M9 3v6H3m18 0h-6V3M3 15h6v6m6 0v-6h6' : 'M9 3H3v6m12-6h6v6M3 15v6h6m6 0h6v-6'} /></svg>;
}

export default function Presentation() {
  const [activeSlide, setActiveSlide] = useState(initialSlide);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [notesLanguage, setNotesLanguage] = useState<NotesLanguage>(initialNotesLanguage);
  const [fullscreen, setFullscreen] = useState(false);
  const [notice, setNotice] = useState('');
  const [videoFile, setVideoFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState('');
  const [videoError, setVideoError] = useState('');
  const pageRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const pointerStart = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    try { window.localStorage.setItem(notesLanguageKey, notesLanguage); }
    catch { /* Notes remain usable when browser storage is unavailable. */ }
  }, [notesLanguage]);

  const goToSlide = useCallback((index: number) => {
    setActiveSlide(Math.min(slides.length - 1, Math.max(0, index)));
    setNotice('');
  }, []);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (pageRef.current?.requestFullscreen) await pageRef.current.requestFullscreen();
      else setNotice('Fullscreen is unavailable in this browser. You can use the browser’s presentation or fullscreen mode.');
    } catch {
      setNotice('Fullscreen could not start. Try the fullscreen button again or use your browser’s fullscreen mode.');
    }
  }, []);

  useEffect(() => {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#slide-${activeSlide + 1}`);
    // Native video pauses here; the YouTube iframe unmounts when leaving its slide.
    if (activeSlide !== 2) videoRef.current?.pause();
  }, [activeSlide]);

  useEffect(() => {
    const followHash = () => goToSlide(initialSlide());
    const followFullscreen = () => setFullscreen(document.fullscreenElement === pageRef.current);
    window.addEventListener('hashchange', followHash);
    document.addEventListener('fullscreenchange', followFullscreen);
    return () => {
      window.removeEventListener('hashchange', followHash);
      document.removeEventListener('fullscreenchange', followFullscreen);
    };
  }, [goToSlide]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || overviewOpen || notesOpen) return;
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select, video, iframe, dialog, [contenteditable="true"]')) return;
      if (event.code === 'Space' && target instanceof Element && target.closest('button, a')) return;
      if (['ArrowRight', 'PageDown'].includes(event.key) || event.code === 'Space') {
        event.preventDefault(); goToSlide(activeSlide + 1);
      } else if (['ArrowLeft', 'PageUp'].includes(event.key)) {
        event.preventDefault(); goToSlide(activeSlide - 1);
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault(); goToSlide(event.key === 'Home' ? 0 : slides.length - 1);
      } else if (event.key.toLowerCase() === 'f') {
        event.preventDefault(); void toggleFullscreen();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeSlide, goToSlide, notesOpen, overviewOpen, toggleFullscreen]);

  useEffect(() => {
    if (!videoFile) { setVideoUrl(''); return; }
    const url = URL.createObjectURL(videoFile);
    setVideoUrl(url);
    setVideoError('');
    return () => URL.revokeObjectURL(url);
  }, [videoFile]);

  const selectVideo = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('video/') && !/\.(mp4|webm|mov|m4v|ogv)$/i.test(file.name)) {
      setVideoError('Please choose a video file, such as MP4 or WebM.');
    } else { setVideoFile(file); setVideoError(''); }
    event.currentTarget.value = '';
  };

  const startSwipe = (event: PointerEvent<HTMLDivElement>) => {
    pointerStart.current = null;
    if (event.pointerType !== 'touch' || (event.target as Element).closest('video, iframe, button, a, input')) return;
    pointerStart.current = { x: event.clientX, y: event.clientY };
  };
  const finishSwipe = (event: PointerEvent<HTMLDivElement>) => {
    const start = pointerStart.current;
    pointerStart.current = null;
    if (!start) return;
    const x = event.clientX - start.x;
    const y = event.clientY - start.y;
    if (Math.abs(x) > 70 && Math.abs(x) > Math.abs(y) * 1.6) goToSlide(activeSlide + (x < 0 ? 1 : -1));
  };

  return <main id="main-content" lang="en" ref={pageRef} data-slide={activeSlide + 1} className={`pitch-page${fullscreen ? ' is-fullscreen' : ''}`}>
    <header className="pitch-header">
      <a href="/" className="pitch-brand" aria-label="Miu home"><span className="pitch-brand-avatar"><img src="/presentation-assets/miu-excited.png" alt="" width="800" height="880" /></span><span>miu<span className="pitch-brand-dot" aria-hidden="true">.</span></span></a>
      <div className="pitch-deck-name"><strong>Meet Miu</strong><span>Sea x OpenAI Codex Hackathon</span></div>
      <a className="pitch-source" href={sourceDeck} download="Meet Miu.pptx" aria-label="Download PowerPoint">Download PowerPoint <span aria-hidden="true">↗</span></a>
    </header>

    <div className="pitch-workspace">
      <div className="pitch-stage" role="region" aria-roledescription="carousel" aria-label="Meet Miu presentation" onPointerDown={startSwipe} onPointerUp={finishSwipe} onPointerCancel={() => { pointerStart.current = null; }}>
        <div className="pitch-slide-deck">
        <section className="pitch-slide pitch-why" hidden={activeSlide !== 0} role="group" aria-roledescription="slide" aria-label="1 of 4: Why Miu">
          <p className="pitch-kicker">Why Miu</p>
          <span className="pitch-slide-number">01 / 04</span>
          <h1>Small stories<br />deserve a<br /><span>familiar friend</span></h1>
          <p className="pitch-why-description">A gentle space for children to share<br />what matters in their day.</p>
          <Room className="pitch-hero-room"><img className="pitch-why-miu" src="/presentation-assets/miu-excited.png" alt="Miu, a blue kitten, greeting you with raised paws" width="800" height="880" draggable="false" /></Room>
          <span className="pitch-wordmark">MIU</span>
        </section>

        <section className="pitch-slide pitch-features" hidden={activeSlide !== 1} role="group" aria-roledescription="slide" aria-label="2 of 4: Meet Miu">
          <h1>Meet Miu</h1>
          <span className="pitch-slide-number">02 / 04</span>
          <div className="pitch-feature-grid">{features.map(feature => <article className="pitch-feature" key={feature.title}>
            <div className="pitch-feature-art wall"><img src={`/presentation-assets/${feature.image}`} alt="" width="800" height="880" draggable="false" /></div>
            <h2>{feature.title}</h2>
            <p>{feature.description}</p>
          </article>)}</div>
        </section>

        <section className="pitch-slide pitch-demo" hidden={activeSlide !== 2} role="group" aria-roledescription="slide" aria-label="3 of 4: Miu in action">
          <h1>Miu in action</h1>
          <span className="pitch-slide-number">03 / 04</span>
          <div className="pitch-video-frame">
            {videoUrl && !videoError ? <video key={videoUrl} ref={videoRef} src={videoUrl} controls playsInline preload="metadata" aria-label="Miu demo video" onError={() => setVideoError('This browser could not play the video. Try an MP4 with H.264 video or a WebM file.')} /> : activeSlide === 2 && <iframe src={demoEmbedUrl} title="Miu demo on YouTube" allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />}
          </div>
          <aside className="pitch-demo-aside">
            <h2>A familiar<br />follow-up</h2>
            <img src="/presentation-assets/miu-listening.png" alt="Miu listening with a paw raised" width="800" height="880" draggable="false" />
            <span className="pitch-wordmark">MIU</span>
          </aside>
        </section>

        <section className="pitch-slide pitch-future" hidden={activeSlide !== 3} role="group" aria-roledescription="slide" aria-label="4 of 4: Future improvements">
          <div className="pitch-future-intro">
            <p className="pitch-kicker">Future improvements</p>
            <h1>A more<br /><span>natural Miu</span></h1>
            <p className="pitch-proposed">Proposed next steps</p>
            <Room className="pitch-future-room"><img src="/presentation-assets/miu-thinking.png" alt="Miu thinking about what comes next" width="800" height="880" draggable="false" /></Room>
          </div>
          <span className="pitch-slide-number">04 / 04</span>
          <div className="pitch-future-grid">{improvements.map((improvement, index) => <article key={improvement.title}>
            <span className="pitch-improvement-number">0{index + 1}</span>
            <h2>{improvement.title}</h2>
            <p>{improvement.description}</p>
          </article>)}</div>
        </section>
        </div>
        <PresentationShare />
      </div>

      {activeSlide === 2 && <div className="pitch-video-options">
        <span>{videoFile && !videoError ? videoFile.name : 'YouTube · Miu demo'}</span>
        <button type="button" onClick={() => videoInputRef.current?.click()}>{videoFile ? 'Change local video' : 'Use local video'}</button>
        {videoFile && <button type="button" onClick={() => { setVideoFile(null); setVideoError(''); }}>Use YouTube video</button>}
        <a href={demoWatchUrl} target="_blank" rel="noopener noreferrer">Watch on YouTube ↗</a>
        <a href="/demo/miu?lang=en" target="_blank" rel="noopener noreferrer">Open live demo ↗</a>
      </div>}
      {videoError && activeSlide === 2 && <p className="pitch-notice" role="alert">{videoError}</p>}
      <input ref={videoInputRef} className="pitch-file-input" tabIndex={-1} type="file" accept="video/*,.mp4,.webm,.mov,.m4v,.ogv" aria-label="Choose a demo video" onChange={selectVideo} />

      <footer className="pitch-controls" aria-label="Presentation controls">
        <div className="pitch-tools">
          <button type="button" className="pitch-tool" onClick={() => setOverviewOpen(true)} aria-label="Show all slides" title="Show all slides"><Icon name="menu" /><span>Overview</span></button>
          <button type="button" className="pitch-tool" onClick={() => setNotesOpen(true)} aria-label="Speaker notes" title={`Speaker notes · ${notesLanguage.toUpperCase()}`}><Icon name="chat" /><span>Notes</span></button>
        </div>
        <nav className="pitch-navigation" aria-label="Slide navigation">
          <button type="button" className="pitch-arrow" aria-label="Previous slide" onClick={() => goToSlide(activeSlide - 1)} disabled={activeSlide === 0}><Icon name="back" /></button>
          <div className="pitch-dots">{slides.map((slide, index) => <button key={slide.theme} type="button" aria-label={`Go to slide ${index + 1}: ${slide.title}`} aria-current={activeSlide === index ? 'step' : undefined} onClick={() => goToSlide(index)}><span /></button>)}</div>
          <span className="pitch-mobile-count">{activeSlide + 1} / {slides.length}</span>
          <button type="button" className="pitch-arrow pitch-next" aria-label="Next slide" onClick={() => goToSlide(activeSlide + 1)} disabled={activeSlide === slides.length - 1}><Icon name="back" /></button>
        </nav>
        <div className="pitch-screen-tools"><span className="pitch-key-hint"><kbd>←</kbd><kbd>→</kbd> to navigate</span><button type="button" className="pitch-tool pitch-present" aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'} title="Fullscreen (F)" onClick={() => void toggleFullscreen()}><ExpandIcon expanded={fullscreen} /><span>{fullscreen ? 'Exit' : 'Present'}</span></button></div>
      </footer>
      {notice && <p className="pitch-notice" role="status">{notice}</p>}
    </div>

    <p className="pitch-screen-reader" aria-live="polite" aria-atomic="true">Slide {activeSlide + 1} of {slides.length}: {slides[activeSlide].title}</p>

    <Dialog open={overviewOpen} onClose={() => setOverviewOpen(false)} title="Meet Miu · All slides" className="pitch-dialog pitch-overview">
      <div className="pitch-overview-grid">{slides.map((slide, index) => <button key={slide.theme} type="button" className={`pitch-preview pitch-preview-${slide.theme}`} aria-current={activeSlide === index ? 'step' : undefined} onClick={() => { goToSlide(index); setOverviewOpen(false); }}>
        <span className="pitch-preview-number">0{index + 1}</span><strong>{slide.title}</strong><span>{slide.label}</span>
      </button>)}</div>
    </Dialog>
    <Dialog open={notesOpen} onClose={() => setNotesOpen(false)} title={`${notesLabels[notesLanguage].title} · ${activeSlide + 1} / ${slides.length}`} lang={notesLanguage} closeLabel={notesLabels[notesLanguage].close} className="pitch-dialog pitch-notes">
      <PresentationNotes slideIndex={activeSlide} language={notesLanguage} onLanguageChange={setNotesLanguage} />
    </Dialog>
  </main>;
}
