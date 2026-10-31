# Little Buddy: UI design for Miu

This folder is the UI design of the Little Buddy parent website for one
Buddy, Miu the talking kitten. It holds three pages (the marketing page,
Create account, and Talk, where the browser plays the toy), the Miu
component they share, the design tokens, static previews, and the notes
needed to build a frontend from it from the first step. It was exported on
2026-10-31 from the Claude Design canvas "Little Buddy Redesign" (drawn
2026-10-30).

The folder is self-contained on purpose. Nothing in it describes or depends
on any code, and it names no other folder, file or repository: take it to a
new project as it is.

Read this file first. It covers what is in the folder, how to read the
design files, the product in one minute, the design language (colours, type,
shapes, pieces, the room, Miu), each of the three pages and how the Talk page
behaves, and the rules to follow when building and when extending the design.

## 1. What is in this folder

```
design/
  INSTRUCTIONS.md         this file
  AGENTS.md               the short rules for coding agents working in this folder
  artboards/              the design source: canvas.json + 6 .dc.html files (3 pages, 2 Talk states, Miu)
  preview/                plain HTML of every artboard + index.html gallery (generated)
  tools/render.mjs        regenerates preview/ from artboards/ (Node 18 or later, no dependencies)
  reference/dc-format.md  the .dc.html authoring format, as the design tool documents it
  reference/tokens.css    the colour and type tokens, light and dark
```

`preview/index.html` is the quickest way to see the design: open it in a
browser. Each card is one artboard rendered in its default state; click a card
for the full-size screen, and the links inside the screens follow the
prototype flow (the marketing page to Create account, Create account to Talk,
Talk back to the marketing page).

## 2. How to read the artboards

Each `artboards/*.dc.html` is one screen or component as the design tool
stores it: ordinary HTML with inline styles, plus a few constructs explained
in `reference/dc-format.md`:

- `{{dotted.holes}}` are filled from `renderVals()` in the script at the
  bottom of the file. That script is also where the alternative states live.
  `Talk.dc.html` has four phases (`answered`, `listening`, `thinking`,
  `resting`) and keeps the current phase and the language toggle in `state`.
  Read `renderVals()` to see the states the static preview does not show.
- `<sc-for list as>` repeats, `<sc-if value>` branches.
- `<dc-import name="Miu" emotion="happy" size="200">` mounts another
  artboard as a component. The components are `Miu.dc.html` (the kitten, the
  only drawing in the design) and `Talk.dc.html`, which `TalkListening` and
  `TalkResting` reuse with a different `phase`, so the previews show three of
  its four states.
- `onClick="{{handler}}"` attributes are prototype interactions. The previews
  drop them.
- Links between screens are the prototype flow: the marketing page to Create
  account, Create account to Talk, and Talk's back button to the marketing
  page. Buttons whose targets are pages outside this design (Sign in, the
  profile button) keep their look and go nowhere (`href="#"`).

`artboards/canvas.json` is the index: every artboard's title, its frame size
(phone screens are 390 x 844, the marketing page 1440 wide and fluid),
whether it was interactive in the canvas, and the three rows of the canvas:
"1 Miu, the new Buddy", "2 Website and sign up", "3 Talking to Buddy".

To regenerate the previews after editing an artboard, from this folder:

```
node tools/render.mjs
```

## 3. The product in one minute

Little Buddy is an AI companion toy for children aged 4 to 8. The toy streams
the child's voice to a backend and plays Buddy's answer; a resting (paused)
Buddy answers nothing. Parents use the website: the marketing page, sign
up and sign in, and behind them the parent area. This design draws one page
of that area, Talk, where the browser itself plays the toy (it opens the
microphone and Miu answers out loud) under the same rules as the physical
toy. On the website Buddy is Miu, a talking kitten, and everything is drawn
with this one character. Buddy speaks Vietnamese and English; the Talk page
switches the conversation language. The toy's name and settings live on
pages outside this design; here the toy is simply called Miu. One rule above
all: the website shows what Buddy answered, never what the child said.

## 4. Design language

### Principles

1. A talking-pet game, not a dashboard. Miu is a character standing in its
   room; controls are toy pieces around it.
2. One palette. Ink and calm blue-grey grounds, one blue "pop" for actions,
   gold only as a small accent (Miu's collar tag).
3. Chunky. Every button and card has a solid bottom "lip" (a hard
   `box-shadow: 0 Npx 0 <lip colour>`) and sinks when pressed (translate down,
   lip shrinks to 1px).
4. Round. Pills at 999px, icon buttons are circles, cards 20 to 32px.
5. Two fonts. Baloo 2 (700/800) for titles, numbers and buttons; Nunito
   (600 to 800) for everything you read.
6. No AI tropes. No gradient washes (Miu's fur is the one gradient), no
   left-border cards, no emoji. Icons are inline stroke SVG, 24px viewBox,
   stroke 2.4 to 2.8, round caps and joins.
7. Motion belongs to the character and to pressing things. Nothing animates
   because a page or a number loaded.
8. Privacy is visible. The website shows Buddy's answers only, and the Talk
   page keeps the conversation behind a button.

### Colour tokens

Every colour is a token; `reference/tokens.css` is the full list with its
light and dark values (plus a few helpers the table leaves out: the pop ink,
the ocean variants, the font stacks, the easing curves, the large shadow). Build
with the token, never the hex. Dark mode follows the system and swaps the
values below.

| Token | Light | Dark | Used for |
|---|---|---|---|
| `--ground` | #F7F9FC | #070C18 | page background |
| `--surface` | #FFFFFF | #0F1729 | cards, buttons, bubbles |
| `--surface-2` | #EEF2F8 | #16213A | row rules, quiet chips |
| `--ink` | #0B1220 | #E6ECF7 | text, outlines on Miu |
| `--ink-2` | #3E4C63 | #C3CEE0 | secondary text |
| `--muted` | #5B6B82 | #94A3BD | captions |
| `--line` | #DDE4EE | #22304D | card lips, white-button lips |
| `--lip` | #C9D6EA | #050912 | round-button and room lips |
| `--pop` | #2F6BFF | same | primary actions, the mic button, Miu's eyes |
| `--pop-deep` | #1A56C4 | same | lips under pop buttons, link text |
| `--pop-soft` | #E3ECFF | #16264D | the wall, quiet pop surfaces, the mic button's idle ring |
| `--pop-text` | #1A56C4 | #A9C1FF | text on light pop |
| `--sky` | #8FB2FF | same | Miu's fur, soft accents |
| `--glow` | #9DBBFF | same | listening ring, tummy glow |
| `--gold` | #E3A548 | same | Miu's collar tag |
| `--ok` / `--ok-soft` / `--ok-ink` | #2E9E5B / #E2F4E8 / #1F5132 | #4CC27E / #12301F / #8FE3B0 | awake, success |
| `--warn` / `--warn-soft` | #8F5A0F / #FBEBD0 | #E3A548 / #3A2A12 | resting, notices |
| `--bad` / `--bad-soft` | #B93F35 / #F8E1DE | #E47A70 / #3D211E | errors, invalid fields |
| `--wall` / `--wall-dot` | #E3ECFF / #CFDDFB | #111A2E / #1A2744 | room wall and its dot grid |
| `--floor` / `--rug` / `--rug-ring` | #D3DFF6 / #FFFFFF / #BFD0F2 | #0C1424 / #16213A / #22304D | room floor and rug |
| `--night` | #111A2E | #070C18 | the window in the room |
| `--ocean` / `--on-ocean` | #0B1220 / #E8EEFA | same | dark surfaces (the resting status chip) |

The design's own names for the same colours: Ink, Pop, Pop deep, Pop soft,
Fur (Sky), Gold.

### Typography

- Baloo 2, weight 800: page titles 22 to 32px on phones; on the marketing
  page the hero title is 76px and section titles 48 to 54px; card titles 19
  to 23px; buttons 17 to 22px; small labels 15px.
- Nunito: body 15 to 18px at line-height 1.4 to 1.5; captions 12 to 14px in
  `--muted`; eyebrows 13 to 14px, 800, uppercase, letter-spacing 0.1 to 0.12em.
- Line heights are tight on titles (1 to 1.15) and roomy on body text.

### Shape and depth

| Piece | Radius | Lip |
|---|---|---|
| Pop button | 18 to 20px, height 50 to 56 | `0 5px 0 --pop-deep` (6px on the big ones) |
| White button | same | `0 5px 0 --line` |
| Round icon button | circle, 46 to 60px | `0 4px 0 --lip` |
| Big mic button | circle, 76 to 104px, 5 to 6px white border | `0 6px 0 --pop-deep` plus a `--pop-soft` ring, a wider `--glow` ring while listening |
| Card | 24 to 26px (32 for the room) | `0 5px 0 --line` |
| Pill / chip | 999px | small lip or none |
| Input | 16 to 18px | 2px `--line` border, pop border when focused |
| Pressed state | | `translateY(3px)`, lip becomes `0 1px 0` |

The only soft shadow is `--shadow-lg`, under sheets, drawers and modals.

### Spacing and layout

- Phone frame 390px: 16px side gutters, a 52px header at top 18px. Cards
  pad 16 to 18px; grids gap 10 to 14px; sections gap 20 to 24px.
- The marketing page is fluid, capped at 1440px, and was tuned for desktop
  widths from 1024 to 1920; its sections stack on a phone.
- The Talk page is drawn at phone width. From 900px it gets room to show the
  conversation log beside the room instead of in a bottom sheet.

### The pieces

Every page is built from the same handful of pieces.

| Piece | Drawn in |
|---|---|
| Chunky buttons: pop and white, block and large sizes | Landing (Get started, Sign in), Register (Create account), Talk (Wake Miu while resting) |
| Round icon buttons: back, profile, language, new conversation, type a message, the chat log | Register (back), Talk |
| Name plate pill with a status dot | Talk |
| Status chip, one look per Talk phase (white, pop while listening, dark while resting) | Talk |
| Cards: feature blocks, the questions parents ask | Landing |
| Buddy's room (section below) | Landing (hero), Register, Talk |
| Speech bubble with Miu's answer | Talk (answered phase) |
| Big mic button with its rings | Talk |
| Inputs with a label and inline validation copy | Register |
| Miu's 14 faces in a grid | Landing ("Fourteen feelings") |

### Buddy's room

The room is the stage wherever Miu appears. Wall `--wall` with a dot grid
(`radial-gradient(--wall-dot 2.5px, transparent 3px)` on a 30px grid), a
night window top-left (`--night` with a white frame, a moon and stars), a
floor band `--floor`, and a white rug ellipse with an inset `--rug-ring`.
Miu stands on the rug. The marketing hero and the Talk page draw the whole
room; the Create account page keeps the wall and the window behind a small
Miu. On the Talk page the round buttons (language, new conversation, type a
message, the chat log) sit around Miu, a status chip names the phase, the
last answer hangs in a speech bubble, and the big mic button is below.

### Miu, the talking kitten

Miu is the one drawing in the design: `artboards/Miu.dc.html`. Its props are
`emotion` (one of the 14 below), `size` (the width in px; the height is 1.1
times that; small avatars crop to the head) and `motion` (breathing and tail
on or off).

- One 400 x 440 SVG: body, cream tummy with the glowing button, paws with
  pink pads, two ears, head with three fur stripes, muzzle, blush, eyes with
  iris, pupil and two highlights, brows, nose, mouth, a pop collar with a
  gold tag, two arms, a tail, and small extras drawn around the head.
- Miu's own colours do not come from tokens and do not change in dark mode:
  fur gradient #C9DAFF to #8FB2FF to #6A90EE, stripes #5B8CFF, cream #FFFFFF
  to #E1E9F7, tail #7FA4F5, inner ears and paw pads #F8E1DE, blush and
  tongue #F7A8B4, hearts #EF5B6E, iris and collar `--pop`, tag `--gold`,
  tummy button `--pop` with a `--glow` halo.
- Every feeling is a handful of knobs on that one drawing, so the faces
  morph instead of swapping pictures: eyes (`open`, `happy` arcs, `closed`,
  `heart`, `wink`), pupil size and gaze offset, brows (`calm`, `up`, `sad`,
  `focus`, `tilt`), a mouth line (`w`, `small`, `flat`, `frown`, `wavy`,
  `smirk`) or an open mouth (`smile`, `laugh`, `o`, `tiny`) with a tongue, ear
  and arm rotations, blush, and one extra (`waves`, `dots`, `sparkle`,
  `love`, `question`, `tear`, `zzz`). The table of knobs per feeling is in
  `renderVals()` of the artboard; port it as data, not as 14 drawings.

The 14 emotions are the ones Buddy's answers carry; anything else is shown
as `neutral`:

| Code | Label | When |
|---|---|---|
| neutral | Calm | while Miu waits |
| listening | Listening | while the child talks (ears up, paw to ear, sound waves, tummy glow) |
| thinking | Thinking | while Miu finds the answer (eyes up, thought dots) |
| happy | Happy | good news |
| excited | Excited | something wonderful (arms up, sparkles) |
| laughing | Laughing | a joke |
| love | Loving | the child says they love Miu (heart eyes) |
| curious | Curious | a really good question (question mark) |
| surprised | Surprised | something amazing (wide eyes, round mouth) |
| wink | Winking | a little secret |
| shy | Shy | a compliment (full blush) |
| confused | Confused | Miu did not catch that (wavy mouth) |
| sad | Sad | the child is sad (ears down, a tear) |
| sleepy | Sleepy | time for a break (eyes closed, zzz) |

Motion: breathing (3.2s), tail wag (2.4s), blinks, and animated transitions
between poses; the tummy button glows with the microphone level while
listening. The Talk page adds cat behaviour (section 5). Everything stops
under `prefers-reduced-motion`.

### Accessibility and copy

- Real `<button>`, `<a href>` and `<input>` with `<label>`; `aria-label` on
  icon-only buttons; decorative SVG `aria-hidden`.
- Text contrast 4.5:1 (`--muted` on white passes); touch targets at least
  44px (the design uses 46 to 60px round buttons and a 104px mic button).
- Voice: warm, short, parent-facing. Miu is named by name. "Pause" and
  "Wake" are the actions, "Awake" and "Resting" the states. Miu never talks
  about money, so the child-facing copy never does either.
- The website speaks Vietnamese and English and every string exists in both;
  the artboards are written in English.

## 5. The pages

### Marketing page (`Landing`, at `/`)

1440 wide, fluid, scrolls as a page. Top to bottom: a header with the logo,
the section links (How it works, Emotions, Safety, FAQ), Sign in and Get
started; the hero with Miu in its room; "Tap the button" and "As simple as
one tap" (the toy's one physical button); "The face speaks before the words"
with the Fourteen feelings grid of Miu faces; "A friend, not a screen";
"Designed for young children from day one" (answers only, never the child's
words); "What parents ask us"; and "Ready for your child's first question?"
with the last call to action. Every call to action leads to Create account.
Sign in leads to the sign-in page, which is not drawn: build it as Create
account with fewer fields. There is no pricing and nothing about credits
anywhere on the website.

### Create account (`Register`, at `/register`)

A phone frame. A round back button to the marketing page, Miu (excited,
150px) on the wall under the window, the title "Create a family account",
the family name, email and password fields with their inline validation copy ("That email doesn't look right.",
"At least 8 characters"), the pop button "Create account", and "Already have
an account? Sign in". In the prototype, creating the account leads straight
to Talk.

### Talk (`Talk`, `TalkListening`, `TalkResting`, at `/app/talk`)

A phone frame that the browser uses to play the toy. Header: back, Miu's
name plate with a status dot, Miu's profile button. The room with Miu large,
a status chip, Miu's last answer in a speech bubble, the round buttons
(conversation language VI / EN, new conversation, type a message, the chat
log), the big mic button with its rings, and a footer line: "This page plays
the toy: Miu listens and answers like the real Buddy."

The four phases and what changes:

| Phase | Miu | Status chip | Mic button |
|---|---|---|---|
| answered (default) | the emotion of the last answer | "Say something to Miu", white | pop, idle ring |
| listening | listening | "Miu is listening…", pop | pop, wide glow ring, stop icon, label "Send now" |
| thinking | thinking | "Miu is thinking…", white | sky, idle ring |
| resting | sleepy | "Miu is resting", dark | grey; a card "Miu is resting" with "A parent paused Miu. Wake Miu to talk again." and a "Wake Miu" button |

How the page behaves (the static artboards cannot show this):

- Hands-free. The microphone opens when the page is ready. Voice detection
  starts a turn when speech is confirmed and ends it after 2 seconds of
  quiet. Frames are ignored while Miu thinks or speaks and for a moment
  after, so Miu's own voice never starts a turn.
- The big button mutes and unmutes while idle, sends now while the child
  talks, and interrupts while Miu speaks. There is no hold-to-talk or
  tap-to-talk anywhere, in behaviour or in copy.
- Nothing the child said is written on the stage. Miu's own answer may show
  in the bubble. The full log (Miu's answers, what Miu heard, and the typing
  box) opens from the chat button: beside the room from 900px, a bottom
  sheet on phones.
- Miu lives on the stage: the face follows each answer's emotion, the
  listening and thinking faces during a turn, the mouth moves while Miu
  talks, the body swells with the voice level and the tummy glows with the
  microphone level. Between turns Miu acts like a cat: an idle act every few
  seconds (ear flick, head tilt, tail swish, hop, stretch), a doze after 90
  seconds with a startled wake, and petting with the pointer (a pat is
  `happy`, a stroke is `love`, with a visible purr). All of it stops under
  reduced motion.
- Resting is a parent's pause. While Miu rests the microphone stays closed;
  "Wake Miu" ends the pause.
- The language button switches the conversation language for the next turn;
  "new conversation" starts a fresh one. The profile button leads to a page
  outside this design.

## 6. Rules when building and continuing

The look:

- Colours only through the tokens in `reference/tokens.css`; add a token
  rather than a hex. Miu's own SVG colours are the exception.
- Two fonts, chunky pieces with a lip, round shapes, inline stroke icons, no
  AI tropes (section 4). Nothing animates on load, and every animation stops
  under `prefers-reduced-motion`.
- The website never shows what the child said. The Talk stage shows no
  transcript, and no hold-to-talk or tap-to-talk wording ever appears.
- Miu is the only Buddy: every place Buddy is drawn (logo, hero, avatars,
  empty states) uses this one character.
- No em dashes in any text, the artboards' copy included. Use a colon, a
  comma or parentheses.

Keeping this folder true:

- If you change the look on purpose, change or add the artboard in
  `artboards/`, run `node tools/render.mjs`, and keep both. Then the design
  stays the record of what the website looks like.
- Do not hand-edit `preview/`; it is generated.
- This folder stays self-contained: it never names other folders, files,
  commits or repositories. Describe the website by its pages and addresses,
  as this file does.

## 7. Previews

Open `preview/index.html` in a browser, or regenerate the previews from this
folder with `node tools/render.mjs` (Node 18 or later, no dependencies).

## 8. Adding a screen or a state

1. Start from the closest artboard (section 5) and its states in
   `renderVals()`.
2. Build it from the existing pieces (section 4) and tokens; put Miu in a
   room if the screen is about the toy.
3. Write the copy in both languages the website speaks, parent-facing and
   short (section 4, "Accessibility and copy").
4. Check phone width (390), 900px and 1440px, dark mode, keyboard focus and
   reduced motion.
5. Add or update the artboard and regenerate the previews.
