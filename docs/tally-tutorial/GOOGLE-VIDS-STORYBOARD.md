# Connect TallyPrime to REKONZA — Google Vids production pack

## Recommended output

- Format: landscape 16:9
- Target length: 70–75 seconds. Extend a scene when narration needs more time; never speed up or truncate the voiceover to meet a shorter duration.
- Audience: Indian business owners, accountants, and bookkeepers
- Tone: calm, trustworthy, practical, non-technical
- Narrator character: **Emma**, one soft adult female American-English off-screen narrator for the entire video; Emma is a voice only, not an on-screen avatar
- Voice character: natural American English with a soft, warm, gentle, reassuring, and professional delivery; clear rather than breathy or whispered; low-to-mid pitch; deliberately relaxed pace of approximately 125–135 words per minute; no energetic advertising tone
- Voice consistency lock: use the same female voice identity, accent, pitch, speed, energy, and volume in every scene. Do not switch narrators, introduce a male voice, use an avatar voice, or generate a different voice scene by scene.
- Voice workflow: generate the complete one-take script with one selected female voice first, then place or split that single audio track across the scenes. If a scene must be regenerated, explicitly select the same saved voice again.
- Completion rule: every voiceover sentence must be read completely in one uninterrupted take. Never cut, mute, fade, shorten, summarize, or stop the audio before the final word. If the narration does not fit, lengthen the scene instead of increasing the reading speed.
- Music: very light modern corporate bed at 8–10% volume; no dramatic rise
- Captions: on, sentence case, lower third, maximum two lines
- Visual rule: use the supplied screenshots for all software UI. Do not ask AI to redraw REKONZA or TallyPrime screens.

## What the project actually does

1. A signed-in REKONZA admin opens **Tally** and creates a one-time pairing code.
2. The code is eight characters, displayed as `XXXX-XXXX`, valid once for 15 minutes.
3. A connector runs on the same PC or server as TallyPrime. It reads Tally locally over HTTP/XML on port 9000.
4. The connector exchanges the pairing code for a restricted token. It never stores the user's REKONZA password.
5. The connector makes outbound requests to REKONZA. The portal does not open an inbound connection to the customer's network.
6. It discovers every open Tally company, then sends company details, groups, ledgers, stock items, vouchers, deletion indexes, and status heartbeats.
7. The default continuous run interval is five minutes. Changed vouchers are sent incrementally; balances and deletion checks are refreshed daily.
8. REKONZA displays the imported books as read-only, including sync freshness and the date the figures are as at.

Important implementation note: this repository contains a command-line connector (`rekonza-tally pair`, `run`, `status`, and `forget`). It does not contain a Windows desktop GUI or installer UI. If a separate installer/GUI exists outside this repository, replace Scene 5's terminal visual with an authentic recording of that product. Do not invent a connector window.

## Copy/paste master prompt for Google Vids Storyboard

### One-line narrator master prompt

> Use only Emma—a soft, warm adult American female off-screen narrator—for every voiceover in the entire video; preserve exactly the same female voice, American accent, low-to-mid pitch, 125–135 WPM pace, volume, and gentle professional tone in every scene; never generate, alternate with, or repeat a male voice; read each script line exactly once, continuously, completely, and without interruption, restart, duplication, omission, early fade, or clipping.

> Create a 70-to-75-second landscape 16:9 customer tutorial titled “Connect TallyPrime to REKONZA.” The audience is Indian business owners and accountants with no technical background. The goal is to show the complete connection flow accurately: install the connector on the TallyPrime PC, enable TallyPrime's data server on port 9000, open REKONZA's Tally page, generate a one-time pairing code, pair and run the connector, confirm the PC is connected, wait for the first sync, and open the synced company in REKONZA. The sole narrator is Emma, a soft adult female American-English off-screen voice. Emma must use natural American English with a soft, warm, gentle, reassuring, and professional delivery. Keep her voice clear and audible, not breathy or whispered, with a low-to-mid pitch and a deliberately relaxed pace of approximately 125–135 words per minute. Avoid an energetic advertising or promotional tone. Lock Emma's exact voice identity, American accent, pitch, speed, energy, and volume across every scene. Never generate, alternate with, or repeat a male voice. Do not switch narrators, use an avatar voice, repeat a spoken line, or create separate-sounding voiceovers for individual scenes. Generate the full narration as one continuous, uninterrupted Emma voiceover and split that same audio across the scenes. Every sentence must be spoken exactly once and completely. Never cut, mute, fade, summarize, omit, restart, duplicate, or stop the narration before its final word. If narration needs more time, extend the scene; never make Emma speak faster. Begin each scene only after the previous sentence is fully complete. Leave a natural 0.4-to-0.6-second breathing gap between scenes, but never insert a pause inside a sentence. Use concise lower-third captions. Use the supplied REKONZA screenshots exactly as uploaded; never redraw, restyle, crop out important controls, or alter software text. Use the supplied 16:9 setup and command cards for the Tally and connector steps. Emphasize these facts: the connector is read-only, the code works once for 15 minutes, no REKONZA password is entered on the Tally PC, the default sync interval is five minutes, and entries continue to be made in TallyPrime. Use gentle zooms, cursor highlights, and simple cross-dissolves. All titles, labels, brand names, and captions must remain fixed in position unless a specific scene says otherwise. Do not apply automatic fly-in, fly-out, throw, spin, bounce, morph, or exit effects to text. Do not use stock footage, fake dashboards, fake buttons, avatars, or invented connector screens. End on the synced Day Book with the message “Connected. Read-only. Up to date.”

## Scene-by-scene plan

### Scene 1 — What the connector does

- Time: 0:00–0:08. Do not shorten this scene; extend it if the voiceover has not finished.
- Reference: `images/00-connector-flow.png`
- Visual: full-frame secure-flow illustration. Add the title and labels as separate native Google Vids text boxes, not as generated-video text: `TallyPrime PC` under the left monitor, `REKONZA connector` under the center device, and `REKONZA` under the right laptop. Keep all text layers static and anchored for the full scene.
- On-screen title: **Connect TallyPrime to REKONZA**
- On-screen subtitle: `Read-only sync in a few simple steps`
- Voiceover: “A read-only connector securely brings your TallyPrime companies into REKONZA.”
- Scene 1 voice-generation prompt:

  > Use Emma, the same soft adult female American-English off-screen narrator selected for the complete video. Speak with Emma's warm, gentle, reassuring, and professional American voice at a relaxed 125–135 words per minute. Never use or layer a male voice. Keep the delivery clear and audible, not breathy or whispered, and avoid an energetic advertising tone. Read the following sentence exactly once, as one smooth and uninterrupted take: “A read-only connector securely brings your TallyPrime companies into REKONZA.” Begin the voice at approximately 0.6 seconds. Do not pause, restart, repeat, duplicate, paraphrase, or insert a break inside the sentence. Pronounce every word clearly. Do not cut off, mute, fade, or stop before completing the final word “REKONZA.” The full final syllable of “REKONZA” must be audible. Finish the sentence naturally by approximately 6.8 seconds, then preserve 0.7 to 1 second of clean room tone before the transition. If the sentence is not complete, automatically extend the scene; never increase the speaking speed and never transition early.
- Animate-image prompt for Google Vids:

  > Keep the uploaded image unchanged. Use a slow, steady camera push-in. Pulse the two blue arrows from left to right once, then give the shield a soft blue confirmation glow. No object movement other than the arrow pulse and shield glow. The title “Connect TallyPrime to REKONZA,” the subtitle, and all three labels must remain completely static, sharp, anchored, and visible from their first frame until the scene has fully cross-dissolved. Do not animate, throw, fly, slide, spin, bounce, zoom, morph, shatter, fade separately, or remove the word “REKONZA.” Do not apply kinetic typography or an automatic text exit effect. Do not generate or redraw text inside the video clip. No new text, devices, logos, or interface elements. Calm enterprise-software tone. Hold the completed frame for the final 0.5 seconds.

- Transition: begin the 250 ms cross-dissolve only after the narrator has completely finished saying `REKONZA` and the clean end hold has played. Do not fade the voice with the transition. Apply the cross-dissolve to the complete visual scene only. Do not add a separate exit animation to the title, labels, or the word `REKONZA`.
- If Google Vids still throws or flies out `REKONZA`: remove that object's animation, set both entrance and exit to **None**, keep it as a native text layer above the animated background, extend the text layer through the final frame, and apply the cross-dissolve only at the scene boundary.

### Scene 2 — Check the prerequisites

- Time: 0:08–0:15
- Reference: `images/01-tally-empty-state.png`
- Visual: show the real REKONZA Tally page. Start wide, then gently zoom toward the three setup cards.
- On-screen text: `Before you start: TallyPrime open • Connector installed • Admin access`
- Voiceover: “Open your Tally company and install the connector on the same PC. One connector covers every open company.”
- Motion prompt:

  > Preserve the screenshot exactly. Begin with the full 16:9 screen. Slowly zoom toward the three setup cards in the center, stopping before any text is cropped. Add a subtle highlight around step 1, “Install the connector.” Do not modify or regenerate any UI text.

- Transition: cut only after Emma has completely finished the final word “company.” Do not overlap, repeat, or carry any Scene 2 narration into Scene 3.

### Scene 3 — Enable Tally's data port

- Time: 0:15–0:24
- Reference: `images/06-tally-port-setup-guide.png`
- Preferred replacement: a real screen recording from the supported TallyPrime version showing the same menu path.
- On-screen text: already present in the guide.
- Voiceover: “In TallyPrime, press F1 Help, open Settings, then Connectivity. Act as server on port 9000, and save with Control plus A.”
- Motion prompt:

  > Keep the guide card sharp and unchanged. Reveal the path from left to right: “F1 Help,” then “Settings,” then “Connectivity.” Next, highlight “Yes,” “9000,” and “Ctrl + A” one at a time. Finish with a soft green highlight on “TallyPrime:9000.” Do not add or rewrite text.

- Cursor recording note: if using real TallyPrime footage, blur company-sensitive data but keep the menu names and `TallyPrime:9000` visible.
- Transition: quick white fade, 200 ms.

### Scene 4 — Generate a pairing code in REKONZA

- Time: 0:24–0:32
- Reference: `images/01-tally-empty-state.png`, followed by `images/02-pairing-code-dialog.png`
- Visual: first show the real Tally page and animate a cursor click on **Connect a PC**. Cut to the real pairing dialog.
- On-screen text: `REKONZA → Tally → Connect a PC`
- Voiceover: “In REKONZA, open Tally and select Connect a PC. The one-time code works for 15 minutes.”
- Motion prompt for the first screenshot:

  > Preserve the screenshot exactly. Move a clean white cursor to the blue “Connect a PC” button in the upper-right, pause briefly, and click once. Use a small click ripple only. Do not alter any UI.

- Motion prompt for the dialog screenshot:

  > Preserve the pairing dialog exactly. Use a very slow push-in toward the pairing code. Add no new code and do not change any characters or labels.

- Security callout: small lower third, `Works once • Expires in 15 minutes`.
- Transition: match cut from the visible code to the same code in Scene 5.

### Scene 5 — Pair and run the current connector

- Time: 0:32–0:43
- Reference: `images/07-connector-command-guide.png`
- Visual: exact command guide. Before publishing, replace `https://YOUR-REKONZA-DOMAIN` with the real production portal URL. Replace the sample code only if recording a live pairing session.
- Voiceover: “On the Tally PC, pair with that code and your portal address, then start the run command. Never enter your REKONZA password.”
- Motion prompt:

  > Keep the terminal card and every character unchanged. Reveal the pair command from left to right as if typed, show the green success line, then reveal the run command. Add a soft green check beside the password-safety note. No extra terminal output, no fake windows, no hands, and no code changes.

- Exact current commands:

  ```powershell
  rekonza-tally pair K7Q2-9MXP --portal https://YOUR-REKONZA-DOMAIN
  rekonza-tally run
  ```

- If the shipping installer has a GUI: replace this scene with an authentic recording of its code field and **Connect** control; keep the same voiceover and security callout.
- Transition: 250 ms cross-dissolve.

### Scene 6 — Confirm pairing

- Time: 0:43–0:49
- Reference: `images/03-pairing-success.png`
- Visual: real REKONZA success dialog.
- On-screen text: no added headline; the dialog already carries the message.
- Voiceover: “REKONZA confirms the PC immediately. Select Done, then leave TallyPrime and the connector running.”
- Motion prompt:

  > Preserve the screenshot exactly. Begin slightly zoomed out, then ease toward the green “Connected to ACCOUNTS-PC” confirmation. Add one subtle pulse to the green check. Do not change the machine name or any dialog text.

- Transition: click **Done**, then cross-dissolve.

### Scene 7 — Wait for the first sync

- Time: 0:49–0:58
- Reference: `images/04-company-synced.png`
- Visual: real synced company card and Connected PCs row.
- On-screen text: `First sync complete`
- Voiceover: “After the first sync, every open company appears with its counts. Changes are checked every five minutes by default.”
- Motion prompt:

  > Preserve the screenshot exactly. Use a slow pan from the company card down to the Connected PCs row. Briefly highlight “Synced just now,” the green online dot, and “1 company.” Do not invent new data or modify counts.

- Transition: animate a cursor click on the company card.

### Scene 8 — Review the read-only books

- Time: 0:58–1:08
- Reference: `images/05-company-day-book.png`
- Visual: real company Day Book. Pan gently across the header badges and then across the available report tabs.
- On-screen text: `Connected. Read-only. Up to date.`
- Voiceover: “Open the company to review its Day Book, ledgers, Trial Balance, Profit and Loss, Balance Sheet, and Stock Summary. Sync freshness stays visible.”
- Motion prompt:

  > Preserve the screenshot exactly. First zoom gently toward the “Read-only” and “Synced just now” badges. Then pan left to right across the report tabs without cropping their labels. Finish on the Day Book totals. Do not modify any amounts, dates, or text.

- Transition: soft fade to closing card.

### Scene 9 — Close with the operating rule

- Time: 1:08–1:12
- Reference: reuse `images/00-connector-flow.png` with a 20% white overlay, or use a plain REKONZA-blue closing card.
- On-screen text:

  **Keep TallyPrime and the connector running**  
  `Need help? Run rekonza-tally status or contact REKONZA support.`

- Voiceover: “Keep TallyPrime and the connector running. Entries remain in Tally.”
- Motion prompt:

  > Static closing frame with a very slow one-percent push-in. No new objects and no logo animation.

- End: music fades out over 500 ms.

## One-take voiceover script

> A read-only connector securely brings your TallyPrime companies into REKONZA. Open your Tally company and install the connector on the same PC. One connector covers every open company. In TallyPrime, press F1 Help, open Settings, then Connectivity. Act as server on port 9000, and save with Control plus A. In REKONZA, open Tally and select Connect a PC. The one-time code works for 15 minutes. On the Tally PC, pair with that code and your portal address, then start the run command. Never enter your REKONZA password. REKONZA confirms the PC immediately. Select Done, then leave TallyPrime and the connector running. After the first sync, every open company appears with its counts. Changes are checked every five minutes by default. Open the company to review its Day Book, ledgers, Trial Balance, Profit and Loss, Balance Sheet, and Stock Summary. Sync freshness stays visible. Keep TallyPrime and the connector running. Entries remain in Tally.

## Asset map

| File | Use |
|---|---|
| `images/00-connector-flow.png` | Generated overview/closing visual |
| `images/01-tally-empty-state.png` | Exact REKONZA Tally setup page |
| `images/02-pairing-code-dialog.png` | Exact one-time code dialog |
| `images/03-pairing-success.png` | Exact connected confirmation |
| `images/04-company-synced.png` | Exact synced company and PC state |
| `images/05-company-day-book.png` | Exact read-only company view |
| `images/06-tally-port-setup-guide.png` | Deterministic 16:9 Tally settings guide |
| `images/07-connector-command-guide.png` | Deterministic 16:9 command-line guide |

The REKONZA screenshots use deterministic tutorial data and the real application components. They contain no customer production data. The generated flow illustration was created from the following prompt:

> Create a clean 16:9 enterprise-software infographic with three evenly spaced stages: a Windows desktop showing an accounting ledger, a small secure connector device with a shield and checkmark, and a modern cloud accounting dashboard. Show outbound-only blue arrows from the desktop through the connector to the cloud dashboard. Use deep navy, REKONZA blue, cyan accents, white cards, and a pale blue-gray background. Use no text, people, passwords, logos, trademarks, or watermarks. Keep generous safe space for titles and captions.

## Google Vids assembly checklist

1. Open a new, blank landscape Vid and use **File → Storyboard**.
2. Paste the master prompt and generate the draft outline.
3. Replace generated media and placeholders with the supplied PNGs. Do not accept AI-redrawn software screens.
4. Select and save one soft adult female American-English voice as **Emma**, then generate the complete one-take script as a single uninterrupted Emma voiceover at 125–135 words per minute. Reuse that exact audio across all scenes; do not generate independent scene voices.
5. Check that the narrator's accent, pitch, pacing, loudness, and pronunciation of `REKONZA` remain identical from the first scene to the last.
6. Listen to the end of every scene before publishing. If even one final word or syllable is clipped, extend that scene and move the transition later. Never solve clipping by increasing narration speed.
7. In Scene 1, keep the scene at least eight seconds long. The narrator must finish the complete word `REKONZA`, followed by 0.7 to 1 second of clean hold, before the visual cross-dissolve begins.
8. In Scene 1, add the title and `REKONZA` labels as native text layers with entrance and exit animation set to **None**. Extend them through the final frame and transition the complete scene with a cross-dissolve.
9. Keep total duration between 70 and 75 seconds. Extend it when necessary to preserve complete, relaxed narration.
10. For animated screenshots, describe only camera/cursor motion. Do not re-describe the UI.
11. Replace the placeholder portal URL before publishing.
12. If a shipping connector GUI exists outside this repository, record and insert it in Scene 5.
13. Record a real supported TallyPrime settings screen for Scene 3 when possible; otherwise use the supplied guide card.
14. Review every displayed code, URL, date, amount, and company name at 100% zoom before export.
15. Export or publish only after removing any live pairing token, customer GSTIN, or confidential books from real recordings.

Google Vids Storyboard can create a suggested outline, media, script, and voiceover from a prompt and related files. Its image animation tool works best when the source is already 16:9 and the prompt describes movement rather than repeating the image content. See Google's official guides: [Plan your video with AI](https://support.google.com/docs/answer/15067819) and [Use AI to generate video clips](https://support.google.com/docs/answer/16143507).

