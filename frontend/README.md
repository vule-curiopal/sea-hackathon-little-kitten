# Little Buddy frontend

Responsive React and TypeScript implementation of the Miu design, built with Vite.

## Run locally

Use Node.js 22.19 or later. Install the root workspace and start the voice API in one terminal:

```sh
npm ci
npm run dev
```

In a second terminal, install and start the frontend:

```sh
cd frontend
npm ci
npm run dev
```

Open `http://localhost:5173`. On Windows PowerShell, use `npm.cmd` if script execution is restricted. The frontend's predev/prebuild scripts compile the shared packages. Vite proxies `/api` to `http://127.0.0.1:3001` in development and preview.

The API defaults to fake mode. The existing root `.env` is read by the backend, never changed by the frontend. Real mode requires the server configuration described in [the pipeline README](../backend/pipeline/README.md). MP4/WebM capture and real MP3 output require `ffprobe` on the server PATH or `FFPROBE_PATH`.

For an iPhone or iPad on the same Wi-Fi, open the **Wi-Fi Network URL** printed by Vite. For example, `http://192.168.x.x:5173`. Do not use the computer's `localhost` address on another device. Keep the development server running while you try the app. The typing demo works over local HTTP. Microphone input on another device requires HTTPS and browser support; `localhost` is only treated as secure on the computer itself.

## Screens

| Path | Screen |
| --- | --- |
| `/` | Landing page, expression picker, FAQ |
| `/register` | Family account form with validation |
| `/login` | Sign-in form with validation |
| `/app/talk` | Miu's interactive room |
| `/demo/miu?lang=en` | Direct, no-sign-in room with the prepared demo buddy |

The room supports petting, pause/wake, starting a new session, Vietnamese/English switching, a local typing demo, and voice through `@miu/voice-client`. Only answers appear in the log, held in browser memory for the current visit. Typed questions stay local; voice recordings go to the configured server and, in real mode, its speech providers. Language and typing-demo read-aloud preferences are stored on the device.

## Keeping company with Miu

Miu begins breathing, blinking, and gently moving its tail as soon as the room opens. After 4.5–7 quiet seconds, Miu independently chooses little activities: looking around, ear flicks, paw grooming, stretching, playing with yarn, and having a pretend fish snack. A shuffled bag randomizes the order and quiet pauses, includes both snack and play, and avoids repeating the same activity consecutively. Miu brings its own snack to its mouth; the child never needs to feed it or authorize its activities. After 82 seconds Miu becomes drowsy, settling into a catnap at 90 seconds. Touch a dozing Miu to wake it with a stretch. Petting Miu directly gives a visual purr and affectionate expression, with no separate pet or play buttons.

**Let Miu rest** explicitly pauses conversation, cancels pending replies and speech, turns off the microphone, and keeps Miu asleep until touched or **Wake Miu** is selected. Waking by touch or Wake does not enable the microphone; deliberately pressing Talk wakes Miu and begins one recording. Idle actions run without network or model calls, yield to listening/thinking/speaking, and stop scheduling while the tab is hidden. A sad typing-demo response suppresses lively idle actions. Reduced-motion preferences keep the poses and readable activity cues without repeated animation. Activity captions are available in Vietnamese and English and do not repeatedly announce themselves to screen readers.

Miu also has a gentle **Dỗi nhẹ / A little pout** expression: puffy cheeks, pursed lips, a sideways glance, relaxed brows, and folded paws. Occasionally, a yarn-playing moment ends with this 2.4-second pretend disappointment before Miu settles on its own. It is never triggered by the child's absence or withheld care. Petting still gives the usual affectionate response, and comfort, conversation, and rest override the pout. The expression is also available in the landing page's fifteen-expression picker.

### Direct touch and toys

Touch Miu directly with a finger, Apple Pencil, or mouse. Stroke the head to purr, tap the nose for a boop, rub the belly for giggles, tap a paw for a high-five, or hold gently for 650 milliseconds to cuddle. Both the automatically dozing and explicitly resting kitten can be woken by a direct touch. Drag the yarn and Miu watches it; drag the fish to Miu's face to offer a pretend snack. Tapping either toy is an alternative to dragging. There are no hunger or affection meters.

Pointer capture and `touch-action: none` apply only to Miu and the two toys, so vertical strokes are handled as petting while the surrounding page keeps normal scrolling and zoom. Long-press selection/callouts are suppressed on these surfaces. Hit regions use SVG coordinates and scale with the character on phones and tablets. Extra fingers are ignored; pointer cancellation, lost capture, hidden tabs, and conversation transitions clear held gestures and dragged toys. Pointer responses do not depend on a synthesized click. Keyboard and screen-reader actions remain available directly through the character and toys. Interaction descriptions are provided to screen readers without a visible instruction guide or separate pet/play buttons.

The implementation targets the same Safari 16.4+ baseline as the frontend. Desktop Chrome direct nose taps and head strokes were verified. Real iPhone/iPad Safari verification remains outstanding; the automated geometry tests cover phone, tablet, and desktop character sizes.

## Ready-to-scan demo

Open `/app/talk` on the presenting laptop. The QR hangs on the wall inside Miu's room, next to the window. The room retains its full responsive layout. Attendees can scan immediately while you talk with Miu.

The typing-demo buddy is Miu: **ENFP, friend, curious, playful, imaginative**. Its greeting, sample responses, default read-aloud setting, and device speech delivery use the preset in `src/lib/demo-buddy.ts`. The voice backend does not implement that personality yet. Scanning opens `/demo/miu` directly, without account forms. Language is carried in the link. Each device has its own local answer log. Voice uses the server's two shared fictional profiles, An and Bình; opening the same profile elsewhere closes its previous session, so this voice prototype does not support an independent voice session for every attendee.

For local demos, attendees must join the laptop's Wi-Fi. When the presenter opens `localhost`, Vite supplies the preferred LAN address through its development-only `/__demo/network` endpoint. The QR encodes that address rather than `localhost`, which would point at the attendee's phone. Microphones on phones require HTTPS; the local HTTP demo supports typing and sample-question buttons.

Generate a reusable local QR file at `public/demo-qr.svg`:

```sh
npm run demo:qr
```

Regenerate it when the laptop's Wi-Fi address changes. The QR on the Talk screen resolves the current address automatically on page load, independently of this exported file.

For a published, publicly accessible HTTPS demo, set `VITE_DEMO_PUBLIC_URL` to its origin before starting or building the frontend. A QR link cannot bypass a hosting provider's private access gate. A public deployment is a separate choice from running the demo locally.

```sh
npm run demo:qr -- https://your-demo.example en
```

QR codes are generated locally with a four-module quiet zone and fixed dark-on-light contrast. Tests use an independent QR decoder to verify both local and HTTPS links in English and Vietnamese.

## Responsive behavior

- Phones: stacked landing page, full-width room, conversation in a keyboard-accessible bottom sheet.
- Tablets: two-column account layout, larger room and character. At 900px and above, an opened conversation panel sits beside Miu.
- Both orientations can scroll naturally on short viewports. Speech bubbles and Miu stay in document flow, including longer Vietnamese answers.
- Safe-area spacing, 16px form inputs to prevent iOS focus zoom, touch targets of at least 44px, system dark mode, and reduced-motion support.

The build targets Safari 16.4 and later. Actual iPhone/iPad Safari verification is still needed; native browser automation was stopped during this implementation.

## Demo and backend boundary

Voice is connected to the Express batch pipeline through `src/lib/usePipelineVoice.ts` and the shared `@miu/voice-client`. A deliberate Talk click records once using MediaRecorder and adaptive RMS endpointing (1,500 ms silence after a signal; 30-second maximum). Send finalizes capture; Stop discards capture or cancels server processing/playback. Microphone tracks close after each recording and on rest, navigation, hidden tabs, settings, and configuration changes. No browser speech-recognition service is used by the room.

The client uploads actual audio/MIME to the canonical multipart turn route, rejects stale responses, plays returned audio, and sends playback receipts from media events. Blocked autoplay exposes an explicit Play answer action. Reconnecting, starting fresh, switching language, changing profile or selecting a voice clears stale answers and recreates/configures the session. Settings offer the five approved voices filtered by language, and fictional profiles An/Bình. Stop/cancellation failures remain visible without restarting the microphone.

The visible mode comes from the server: fake mode explicitly chooses `voice_sample_vi` or `voice_sample_en` and plays its fixed reference recording, which says Buddy. It does not recognize or answer arbitrary speech. Real mode sends no fixture and uses the server's STT → reply → TTS adapters. The current `voice_stub` envelope supplies no character presentation or memory; voice replies use a neutral face, with local idle animation. Personality, relationship, diary and Next day features are not fabricated.

Typing remains the bounded local sample provider in `src/lib/demo.ts`, explicitly labeled separately from live voice and reference recordings. Its optional read-aloud uses the device voice; that preference does not mute returned voice-service audio. Forms still validate without creating accounts or authenticating. Email/password values are not persisted or sent.

Production must route `/api` to the Express backend, or build with `VITE_VOICE_API_URL=https://your-voice-api.example` and configure backend `ALLOWED_ORIGINS` for the frontend's HTTPS origin. Keep provider secrets server-side. The existing static Sites deployment cannot host this Node/Express service; without a separately hosted API, it can only offer the typing demo and a visible voice-unavailable state.

## Checks and production output

```sh
npm test
npm run build
npm run preview
```

`build` runs TypeScript checks and emits `dist/`. Production hosting must serve `index.html` for application paths such as `/app/talk` to support direct links and refreshes. Google Fonts provides Baloo 2 and Nunito; system font fallbacks apply when fonts cannot load.

Tests cover account validation, pause/wake, stale replies while paused, conversation resets, language selection, all fifteen expressions, the gentle pout's distinct pose and automatic recovery, keeping questions out of conversation state, the idle-to-sleep routine, delayed activity timers, comfort behavior, conversation/rest precedence, touch geometry at phone/tablet/desktop sizes, held versus moving gestures, snack drop regions, toy bounds, and valid reaction/gaze poses.

## Design source

The original design remains in `../design/design`. `src/components/MiuArtwork.tsx` is generated from its single Miu SVG. Expression data is in `src/lib/miu-pose.ts`; styling uses the supplied design tokens.

After changing the original Miu SVG or tokens, run:

```sh
npm run sync:artwork
```

This refreshes the generated artwork and copies the design tokens into the frontend. Application components, page styles, and translated copy live under `src/`.

## Hosted deployment

The frontend is deployed privately at https://little-buddy-curiopal.gauzymacaw.chatgpt.site. The requested custom hostname is `little-buddy.curiopal.com`; it is registered with the hosting service and awaiting Cloudflare DNS verification.

The Site identity is retained in `.openai/hosting.json`. Its static configuration enables single-page application fallback, so direct visits to `/register`, `/login`, and `/app/talk` load the app.

The local deployment checkout is `../.site-deploy/little-buddy`, ignored by the main repository. It contains the exact built assets under `dist/` and a separate Git history for the hosting service. Application source remains here in `frontend/`. For an update, rebuild this frontend, refresh the deployment checkout's `dist/`, then use the Sites source workflow to push, package, and deploy the matching version. Do not create a second Site or replace the stored project ID.

In Cloudflare's `curiopal.com` DNS zone, add:

| Type | Name | Content |
| --- | --- | --- |
| CNAME | `little-buddy` | `custom-domains.chatgpt.site` |
| TXT | `_openai-site-verification.little-buddy` | `openai-site-verification=zrAaASjcBWHuiLwir9h127ZTkti1PHCcb561LfbXHKA` |
| TXT | `_cf-custom-hostname.little-buddy` | `b917d6b1-1f4d-4515-a539-09f56564d1d8` |

Use DNS-only mode for the CNAME and automatic TTL. These public verification records belong to this specific custom hostname. Once the records resolve, refresh the custom-domain status through Sites to confirm hostname and HTTPS activation. Hosting access is currently private; configuring DNS does not change the audience.
