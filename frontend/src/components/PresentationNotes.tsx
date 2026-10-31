import speakerNotes from '../pages/slide/meet-miu-notes.json';

export type NotesLanguage = 'vi' | 'en';

export const notesLabels = {
  vi: { title: 'Ghi chú', close: 'Đóng ghi chú', language: 'Ngôn ngữ ghi chú', switchLanguage: 'Chuyển ghi chú sang tiếng Anh', cue: 'Gợi ý trình chiếu' },
  en: { title: 'Speaker notes', close: 'Close notes', language: 'Notes language', switchLanguage: 'Switch speaker notes to Vietnamese', cue: 'Presenter cue' },
};

export default function PresentationNotes({ slideIndex, language, onLanguageChange }: {
  slideIndex: number;
  language: NotesLanguage;
  onLanguageChange: (language: NotesLanguage) => void;
}) {
  const note = speakerNotes[slideIndex];
  const labels = notesLabels[language];

  return <section className="pitch-notes-content" lang={language}>
    <div className="pitch-notes-toolbar">
      <span>{labels.language}</span>
      <button type="button" className="pitch-notes-language" aria-label={labels.switchLanguage} title={labels.switchLanguage} aria-controls="pitch-notes-script" onClick={() => onLanguageChange(language === 'vi' ? 'en' : 'vi')}>
        <span className={language === 'vi' ? 'is-active' : ''} aria-hidden="true">VI</span>
        <span className={language === 'en' ? 'is-active' : ''} aria-hidden="true">EN</span>
      </button>
    </div>
    <h3>{note.title[language]}</h3>
    <div id="pitch-notes-script" className="pitch-notes-script">{note.script[language].map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>
    <aside className="pitch-notes-cue" aria-labelledby="pitch-notes-cue-title"><strong id="pitch-notes-cue-title">{labels.cue}</strong><p>{note.cue[language]}</p></aside>
  </section>;
}
