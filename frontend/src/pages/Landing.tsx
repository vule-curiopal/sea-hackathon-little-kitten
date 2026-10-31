import { useState } from 'react';
import Miu from '../components/Miu';
import Room from '../components/Room';
import Icon from '../components/Icon';
import { useLanguage, type TranslationKey } from '../lib/i18n';
import { getContent } from '../lib/content';
import { emotions, type Emotion } from '../lib/miu-pose';

export function Brand() {
  return <a className="brand" href="/" aria-label="Little Buddy"><span className="brand-avatar"><Miu /></span><span>Little Buddy<span className="brand-dot">.</span></span></a>;
}

export default function Landing() {
  const { t, language, setLanguage } = useLanguage();
  const [menuOpen, setMenuOpen] = useState(false);
  const [emotion, setEmotion] = useState<Emotion>('happy');
  const [picked, setPicked] = useState(false);
  const content = getContent(language);
  const emotionKey = (feeling: Emotion): TranslationKey => feeling === 'neutral' ? 'calm' : feeling;
  return <>
    <header className="site-header container">
      <Brand />
      <nav className={`main-nav ${menuOpen ? 'is-open' : ''}`} aria-label={t('menu')}>
        {(['how', 'emotions', 'safety', 'faq'] as const).map(key => <a key={key} href={`#${key}`} onClick={() => setMenuOpen(false)}>{t(key)}</a>)}
        <a href="/app/growth" onClick={() => setMenuOpen(false)}>{t('growthLink')}</a>
      </nav>
      <div className="header-actions">
        <button className="language-toggle" onClick={() => setLanguage(language === 'en' ? 'vi' : 'en')} aria-label={t('language')}><Icon name="globe" /><span>{language === 'en' ? 'VI' : 'EN'}</span></button>
        <a className="button button-white header-signin" href="/login">{t('signIn')}</a>
        <a className="button button-primary header-start" href="/register">{t('getStarted')}<Icon name="arrow" /></a>
        <button className="round-button menu-toggle" aria-label={menuOpen ? t('close') : t('menu')} aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}><Icon name={menuOpen ? 'close' : 'menu'} /></button>
      </div>
    </header>

    <main id="main-content">
      <section className="hero container" aria-labelledby="hero-title">
        <div className="hero-inner wall">
          <div className="hero-copy">
            <span className="eyebrow-pill"><span className="small-dot" />{t('age')}</span>
            <h1 id="hero-title">{t('heroOne')}<br /><span>{t('heroTwo')}</span></h1>
            <p>{t('heroBody')}</p>
            <div className="hero-actions"><a className="button button-primary button-large" href="/register">{t('start')}<Icon name="arrow" /></a><a className="text-link" href="#how">{t('seeHow')}<Icon name="chevron" /></a></div>
            <div className="hero-trust"><span><Icon name="globe" />{t('bilingual')}</span><span><Icon name="shield" />{t('parentLed')}</span></div>
          </div>
          <Room className="hero-room">
            <div className="hero-speech"><span className="speech-byline">Miu<span className="tiny-dot" />{t('happyToMeet')}</span><p>{t('heroAnswer')}</p><span className="speech-tail" /></div>
            <Miu emotion="excited" className="hero-miu" />
            <span className="room-nameplate"><span className="small-dot" />{t('meetMiu')}<Icon name="heart" /></span>
          </Room>
        </div>
        <div className="hero-footnote"><span className="short-rule" />{t('discover')}<span className="short-rule" /></div>
      </section>

      <section id="how" className="section container" aria-labelledby="how-title">
        <div className="section-heading"><span className="eyebrow">{t('how')}</span><h2 id="how-title">{t('howTitle')}</h2><p>{t('howBody')}</p></div>
        <div className="steps-grid">{content.steps.map((step, i) => <article className="step-card" key={step.emotion}><span className="step-number">0{i + 1}</span><div className="step-picture"><Miu emotion={step.emotion} /></div><h3>{step.title}</h3><p>{step.body}</p></article>)}</div>
      </section>

      <section id="emotions" className="section emotion-section" aria-labelledby="emotions-title">
        <div className="container"><div className="section-heading"><span className="eyebrow">{t('emotions')}</span><h2 id="emotions-title">{t('emotionTitle')}</h2><p>{t('emotionBody')}</p></div>
          <div className="emotion-playground">
            <div className="emotion-feature wall"><span className="eyebrow-pill"><Icon name="heart" />{t(emotionKey(emotion))}</span><Miu emotion={emotion} alive={picked} /><span className="emotion-hint">{t('emotionHint')}<Icon name="arrow" /></span></div>
            <div className="emotion-grid">{emotions.map(feeling => <button key={feeling} className={`emotion-tile ${emotion === feeling ? 'is-selected' : ''}`} onClick={() => { setEmotion(feeling); setPicked(true); }} aria-pressed={emotion === feeling}><Miu emotion={feeling} /><span>{t(emotionKey(feeling))}</span></button>)}</div>
          </div>
        </div>
      </section>

      <section className="section container offline-section">
        <Room className="offline-room"><div className="little-bubble"><Icon name="heart" /></div><Miu emotion="curious" /><div className="toy-block block-one" aria-hidden="true">M</div><div className="toy-block block-two" aria-hidden="true">i</div><div className="toy-block block-three" aria-hidden="true">u</div></Room>
        <div className="offline-copy"><span className="eyebrow">{t('offlineEyebrow')}</span><h2>{t('offlineTitle')}</h2><p>{t('offlineBody')}</p><ul className="check-list">{(['offlinePointOne', 'offlinePointTwo', 'offlinePointThree'] as const).map(key => <li key={key}><span><Icon name="check" /></span>{t(key)}</li>)}</ul></div>
      </section>

      <section id="safety" className="section container" aria-labelledby="safety-title">
        <div className="section-heading"><span className="eyebrow">{t('safety')}</span><h2 id="safety-title">{t('safetyTitle')}</h2><p>{t('safetyBody')}</p></div>
        <div className="safety-grid">{content.safety.map(feature => <article className="safety-card" key={feature.title}><span className="feature-icon"><Icon name={feature.icon} /></span><div><h3>{feature.title}</h3><p>{feature.body}</p></div></article>)}</div>
      </section>

      <section id="faq" className="section container faq-section" aria-labelledby="faq-title"><div className="section-heading"><span className="eyebrow">{t('faq')}</span><h2 id="faq-title">{t('faqTitle')}</h2></div><div className="faq-list">{content.faq.map((faq, index) => <details key={`${language}-${index}`} open={index === 0}><summary>{faq.q}<Icon name="chevron" /></summary><p>{faq.a}</p></details>)}</div></section>

      <section className="cta-section container"><div className="cta-inner wall"><Miu emotion="wink" /><div><span className="eyebrow">Little Buddy</span><h2>{t('ctaTitle')}</h2><p>{t('ctaBody')}</p></div><a className="button button-primary button-large" href="/register">{t('getStarted')}<Icon name="arrow" /></a></div></section>
    </main>
    <footer className="site-footer container"><div><Brand /><p>{t('footer')}</p><small>{t('footerNote')}</small></div><div className="footer-links"><a href="#safety">{t('safety')}</a><a href="#faq">{t('faq')}</a></div><span className="footer-year">© {new Date().getFullYear()} Little Buddy</span></footer>
  </>;
}
