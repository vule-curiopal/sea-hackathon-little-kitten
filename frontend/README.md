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

The integrated application uses the real character and memory provider. Load provider credentials only in the server environment, as described in [the backend README](../backend/README.md). The frontend never receives provider keys. The standalone voice pipeline can still be used for development; its provider mode is displayed explicitly. MP4/WebM capture and real MP3 output require `ffprobe` on the server PATH or `FFPROBE_PATH`.

For an iPhone or iPad on the same Wi-Fi, open the **Wi-Fi Network URL** printed by Vite. For example, `http://192.168.x.x:5173`. Do not use the computer's `localhost` address on another device. Keep the development server running while you try the app. Typed messages work over local HTTP when the backend is connected. Microphone input on another device requires HTTPS and browser support; `localhost` is only treated as secure on the computer itself.

## Screens

| Path | Screen |
| --- | --- |
| `/` | Landing page, expression picker, FAQ |
| `/register` | Family account form with validation |
| `/login` | Sign-in form with validation |
| `/app/talk` | Miu's interactive room |
| `/demo/miu?lang=en` | Direct, no-sign-in room with the prepared demo buddy |

The room supports petting, pause/wake, new sessions, Vietnamese/English switching, voice, and typed messages through the same character and memory engine. Only approved answers appear in the log, held in browser memory for the current visit. The server receives typed messages and voice recordings; real providers process the corresponding requests. The display-language preference stays on the device. Demo tokens and conversation answers are never written to localStorage.

Settings provide fictional profiles **An / Bình**, sixteen bounded personality presets, three roles (friend, big sibling, teacher), and approved voices filtered by language. Switching profile, language, voice, role, or preset cancels the current operation and clears stale captions before reconnecting. Changing style preserves the server's saved character and child memories.

The **Adult demo panel** shows current server data: names, hobbies and preferences, social relationships, reported events, story checkpoints, the fictional diary, daily growth, and effective time. It does not fabricate remembered details. **Next day** advances the demo clock, clears playback state, and opens a fresh session. A greeting requires the explicit **Say hello** action; the room never speaks on page load or in the background.

## Keeping company with Miu

Miu begins breathing, blinking, and gently moving its tail as soon as the room opens. After 4.5–7 quiet seconds, Miu independently chooses little activities: looking around, ear flicks, paw grooming, stretching, playing with yarn, and having a pretend fish snack. A shuffled bag randomizes the order and quiet pauses, includes both snack and play, and avoids repeating the same activity consecutively. Miu brings its own snack to its mouth; the child never needs to feed it or authorize its activities. After 82 seconds Miu becomes drowsy, settling into a catnap at 90 seconds. Touch a dozing Miu to wake it with a stretch. Petting Miu directly gives a visual purr and affectionate expression, with no separate pet or play buttons.

**Let Miu rest** explicitly pauses conversation, cancels pending replies and speech, turns off the microphone, and keeps Miu asleep until touched or **Wake Miu** is selected. Waking by touch or Wake does not enable the microphone; deliberately pressing Talk wakes Miu and begins one recording. Idle actions run without network or model calls, yield to listening/thinking/speaking, and stop scheduling while the tab is hidden. The engine’s comfort state suppresses lively idle actions, purring, giggling, and toy play. Reduced-motion preferences keep the poses and readable activity cues without repeated animation. Activity captions are available in Vietnamese and English and do not repeatedly announce themselves to screen readers.

Miu also has a gentle **Dỗi nhẹ / A little pout** expression: puffy cheeks, pursed lips, a sideways glance, relaxed brows, and folded paws. Occasionally, a yarn-playing moment ends with this 2.4-second pretend disappointment before Miu settles on its own. It is never triggered by the child's absence or withheld care. Petting still gives the usual affectionate response, and comfort, conversation, and rest override the pout. The expression is also available in the landing page's fifteen-expression picker.

### Direct touch and toys

Touch Miu directly with a finger, Apple Pencil, or mouse. Stroke the head to purr, tap the nose for a boop, rub the belly for giggles, tap a paw for a high-five, or hold gently for 650 milliseconds to cuddle. Both the automatically dozing and explicitly resting kitten can be woken by a direct touch. Drag the yarn and Miu watches it; drag the fish to Miu's face to offer a pretend snack. Tapping either toy is an alternative to dragging. There are no hunger or affection meters.

Pointer capture and `touch-action: none` apply only to Miu and the two toys, so vertical strokes are handled as petting while the surrounding page keeps normal scrolling and zoom. Long-press selection/callouts are suppressed on these surfaces. Hit regions use SVG coordinates and scale with the character on phones and tablets. Extra fingers are ignored; pointer cancellation, lost capture, hidden tabs, and conversation transitions clear held gestures and dragged toys. Pointer responses do not depend on a synthesized click. Keyboard and screen-reader actions remain available directly through the character and toys. Interaction descriptions are provided to screen readers without a visible instruction guide or separate pet/play buttons.

The implementation targets the same Safari 16.4+ baseline as the frontend. Desktop Chrome direct nose taps and head strokes were verified. Real iPhone/iPad Safari verification remains outstanding; the automated geometry tests cover phone, tablet, and desktop character sizes.

## Ready-to-scan demo

Open `/app/talk` on the presenting laptop. The QR hangs on the wall inside Miu's room, next to the window. The room retains its full responsive layout. Attendees can scan immediately while you talk with Miu.

Scanning opens `/demo/miu` directly, without account forms. Language is carried in the link. Each device has its own in-memory answer log. The server's fictional profiles An and Bình are shared: opening the same profile elsewhere closes its previous session, so use distinct profiles for simultaneous demonstrations.

For local demos, attendees must join the laptop's Wi-Fi. When the presenter opens `localhost`, Vite supplies the preferred LAN address through its development-only `/__demo/network` endpoint. Microphones on phones require HTTPS; local HTTP can use typed messages against the connected backend.

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

The visible mode comes from the server. The integrated `character_memory` response supplies approved presentation, expression, and memory metadata. The kitten maps those expressions to its existing artwork. Its mouth opening comes from an analyser attached to approved reply playback, never from microphone levels. Browser autoplay rejection exposes a **Play answer** action; actual media events send started/completed/interrupted playback receipts.

Typed messages use the same session coordinator and server endpoint as microphone turns. By default, typed answers use approved server TTS. Turning off **Read answers aloud** requests `audio:null`: after reading the visible answer, explicitly select **Done reading** to finish the turn. This sends text-delivery receipts with `played_ms:0`, and never claims audible playback. Stop discards a pending text delivery. Saved memories and story progress commit only after the appropriate delivery completion. A deletion response, including deletion followed by a provider failure, clears old captions and cached reply metadata.

The standalone voice pipeline’s fake mode remains a frontend/pipeline development option. It is labeled reference audio and never counts as evidence of character, memory, or model quality. No local sample-reply or browser speech-synthesis path is used by the room. Account forms remain visual demonstrations; email/password values are not persisted or sent.

Production can serve `frontend/dist` from the integrated Express app. Otherwise route `/api` to that backend, or build with `VITE_VOICE_API_URL` and configure the allowed HTTPS origin. Keep provider secrets server-side. The previous static Sites deployment cannot host the Node/Express service by itself; it needs a reachable API.

## Checks and production output

```sh
npm test
npm run build
npm run preview
```

`build` runs TypeScript checks and emits `dist/`. Production hosting must serve `index.html` for application paths such as `/app/talk` to support direct links and refreshes. Google Fonts provides Baloo 2 and Nunito; system font fallbacks apply when fonts cannot load.

Offline unit checks cover account validation, pause/wake, stale replies while paused, conversation resets, language selection, all fifteen expressions, the gentle pout's distinct pose and automatic recovery, keeping questions out of conversation state, the idle-to-sleep routine, delayed activity timers, comfort behavior, conversation/rest precedence, touch geometry at phone/tablet/desktop sizes, held versus moving gestures, snack drop regions, toy bounds, and valid reaction/gaze poses. These checks establish frontend and harness behavior only; character and memory quality evaluations require actual model requests.

## Design source

The original design remains in `../design/design`. `src/components/MiuArtwork.tsx` is generated from its single Miu SVG. Expression data is in `src/lib/miu-pose.ts`; styling uses the supplied design tokens.

After changing the original Miu SVG or tokens, run:

```sh
npm run sync:artwork
```

This refreshes the generated artwork and copies the design tokens into the frontend. Preserve the approved-playback mouth overlay when regenerating `MiuArtwork.tsx`. Application components, page styles, and translated copy live under `src/`.

## Self-hosted deployment

The frontend and Express API are served together at **https://miu.curiopal.com**. The direct demo is https://miu.curiopal.com/demo/miu?lang=vi. Nginx serves the built `dist/` with SPA fallback and proxies `/api` to the isolated voice service. The build sets `VITE_DEMO_PUBLIC_URL=https://miu.curiopal.com`; `VITE_VOICE_API_URL` is empty for same-origin requests. The UI displays the mode returned by the server; check `provider_mode` at https://miu.curiopal.com/api/health for the current runtime setting.

Deployment is manual, with versioned releases, health checks and rollback. See [deploy/miu](../deploy/miu/README.md) for commands and server paths. No GitHub webhook is configured. The separate Sites deployment below is preserved.

## Separate Sites deployment

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
