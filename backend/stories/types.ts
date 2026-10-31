export interface BilingualText {
  readonly en: string;
  readonly vi: string;
}

/** Four short, speakable chapters: discovery, attempt, solution, and ending. */
export interface StoryPlot {
  readonly id: string;
  readonly title: BilingualText;
  readonly theme: string;
  readonly scenes: readonly [BilingualText, BilingualText, BilingualText, BilingualText];
}

export interface StorySetting {
  readonly id: string;
  readonly name: BilingualText;
  readonly place: BilingualText;
  readonly clue: BilingualText;
}

export interface StoryTemplate {
  readonly templateId: string;
  readonly title: BilingualText;
  readonly theme: string;
  readonly settingId: string;
  readonly plotId: string;
  readonly scenes: readonly BilingualText[];
}
