# Walkthrough recorder: WebKit/iPad device test (FUN-06)

The recorder in `crew/gameplan.html` (`crew/gameplan-recorder.js`) is covered by node tests
(`tests/walkthrough-recorder.test.mjs`) and Chromium browser tests (`tests/browser/test_gameplan_recorder_ui.py`,
375x812 and 820x1180) with a fake MediaRecorder. Those cannot prove how Safari on a real iPad records, sleeps and
uploads. Run this checklist on the iPad the sales reps use, on the deployed site, before telling reps to rely on it.
Record the iPadOS version, the Safari version and the result of each step in the release PR. One gameplan tab holds each
walkthrough, from Start until it leaves the iPad: only that tab records, uploads, finishes or withdraws it, and any other
tab shows "This walkthrough is open in another tab on this iPad — use that tab." **iPads must run iPadOS 15.4+**: its
Safari has Web Locks, which tell another tab (or the tab's next page) that the holding page is gone, so it takes the
walkthrough back (steps 14, 23, 28 and 33). Recording in the Hub needs them. On an older iPad the recorder records nothing
in the Hub and holds no walkthrough: the card says "Recording in the Hub needs iPadOS 15.4 or later. Update this iPad in
Settings > General > Software Update, or record in Voice Memos and add the file here." (step 36, Known limits).

## Setup

1. `EGC_WALKTHROUGH_VISIT_ENABLED=true` and `EGC_OPERATIONS_ENABLED=true` are set for the environment under test. Note whether
   `EGC_OFFLINE_CLOCK_ENABLED` is set: step 11 differs (it is unset by default).
2. A synthetic walkthrough visit ("Synthetic Customer", your own phone number) is booked for today and assigned to
   the test rep, with an exact customer link (otherwise uploads return `recording_customer_link_missing`).
3. Sign in on the iPad as the test rep. Open the walkthrough from Crew home.
4. Settings › Safari › Microphone: "Ask" (the default). Leave Auto-Lock at its normal value for step 6.
5. Book a second synthetic walkthrough ("Synthetic Neighbour") for later today, assigned to the same rep, for step 11.
6. iPads must run iPadOS 15.4+ (Settings › General › About). Update any older iPad in Settings › General › Software Update
   (every iPad that runs iPadOS 15 can run 15.8), after step 36 if you still have one to test it on.

## Checks

| # | Step | Expected |
|---|---|---|
| 1 | Open the walkthrough. | The "Walkthrough recording" card shows the customer and **Start walkthrough**. The page does not scroll sideways in portrait or landscape. |
| 2 | Tap Start while clocked out. | "You are not clocked in" with Open time clock / I clocked in / Start without timecard. |
| 3 | Clock in, tap I clocked in, then **Recording OK**. | Safari asks for the microphone once; after Allow the bar reads "Recording · 0:0x · Part 1" with a red dot. |
| 4 | Mime type: in the Unsent list after Finish (or Web Inspector: `EGCWalkthroughRecorder.page.recorder.status().part`). | `audio/mp4`, extension `m4a`. Note it if Safari reports anything else. |
| 5 | Talk for 2 minutes, tapping through the plan and taking 3 photos with the camera. | The recording continues. If taking photos starts new parts with a warning, record how many; it is acceptable but must be noted. |
| 6 | Let the screen auto-lock (or press the top button) for 1 minute, then unlock. | Where Screen Wake Lock works (iPadOS 16.4+), Auto-Lock does not fire while recording. After a forced lock: a red warning "The screen locked or Safari left the foreground … away 1:0x", recording continues in a new part, and the audio after the lock is present. The warning has **Dismiss**, and it clears by itself after a minute of healthy recording. |
| 7 | Switch to another app for 30 seconds, then back. | Same warning and a new part. |
| 8 | Receive a phone call (or start Siri) while recording, then return. | Either Safari mutes the microphone: the bar warns "The microphone was taken at … by a call, Siri or another app", and on return "The microphone came back at … after m:ss; the recording was silent for that time" (the part keeps recording). Or the track ends: the part closes and recording restarts in a new part, or the bar shows "Recording paused" with **Resume**, which works. Note which one Safari does. |
| 9 | New walkthrough with Airplane mode on from the start (clocked in): Start, **Recording OK**, record 3 minutes (longer than the 2-minute offline clock window). Tap Finish, choose Quote to follow, Save outcome. | "Outcome saved on this iPad: Quote to follow. It is sent when the signal allows, then the audio uploads." The **Unsent recordings on this iPad · 1** badge shows Start/Outcome waiting and the parts "Waiting for signal". |
| 10 | Still offline: close Safari completely and reopen the gameplan. | Safari shows the crew offline page: the gameplan itself is not cached for offline use (only Today's work is). Nothing is lost; the audio and the saved Start/Outcome stay in the iPad's storage. |
| 11 | Airplane mode off, then open the **other** walkthrough ("Synthetic Neighbour", the next appointment) from Crew home, as a rep does after driving on. | The badge and parts are back. **Default (`EGC_OFFLINE_CLOCK_ENABLED` unset):** the timecard refuses the late Start time. Above Synthetic Neighbour's own card, a red panel reads "The walkthrough for Synthetic Customer (Sep …, 9:00 AM) needs your decision." with "Start needs your decision: Offline clock times are not enabled…", the note that Retry would be refused again, and **Start without timecard** / Dismiss / Open that walkthrough (no Retry, no silent wait); the audio parts upload in order meanwhile. Synthetic Neighbour's **Start walkthrough** stays below. Tap **Start without timecard**: Start and Outcome are saved, the panel and the badge disappear; opening Synthetic Customer shows "Outcome recorded: Quote to follow" with its real 9:00 start. **With `EGC_OFFLINE_CLOCK_ENABLED=true`:** no decision is asked; within a minute (or tap Send now) Start and Outcome are saved and the parts upload in order with a progress bar. |
| 11a | Repeat step 9 but go back online while still recording (before Finish). | The card shows the same choice, and the recording bar at the bottom says "Start needs your decision." on one line with **Decide**, which scrolls to the card's **Start without timecard**; tapping it sends the Start while recording continues. |
| 11b | Repeat step 11a on the Review step (portrait, then landscape) and scroll to the bottom. | The bar (with the decision and a warning) never covers **Save brief + schedule** or **Clear signature**: the plan scrolls clear of it. |
| 12 | In the Hub Action Center, open the visit's recordings. | One recording per part, in order. Each plays back fully (chunk concatenation), including the audio just before and after each part boundary: on a live microphone the next part starts before the previous one stops, so a boundary repeats up to a second rather than leaving a gap (after a screen lock the gap is the time away). |
| 13 | Long recording: record 21 minutes without locking. | The bar moves to Part 2 at about 20:00; both parts upload; each is under 24 MB. |
| 14 | Reload the page while recording (pull to refresh, accept the prompt). | "The page closed while recording. The audio saved on this iPad is kept." (if the bar first reads "Open in another tab", it must switch within about 5 seconds, as the reloaded page's Web Lock goes; note it). Resume starts a new part; both parts upload. |
| 15 | New walkthrough: **Customer declined recording**. | Safari never asks for the microphone; the bar reads "Walkthrough (not recorded)". Finish requires the three notes for Quote to follow; nothing is uploaded (no recording row appears). |
| 16 | New walkthrough: Recording OK, then deny the microphone (Settings › Safari › Microphone: Deny). | "Microphone access is blocked…" with Continue without recording. At Finish, "Add the Voice Memos file instead (.m4a)" accepts a Voice Memos export (Share › Save to Files) and uploads it. |
| 17 | After an outcome, upload a Voice Memos `.m4a` under 24 MB from the card. | It uploads and plays back. A file over 24 MB is refused on the iPad with the size named. |
| 18 | Customer withdrew consent: during a recorded walkthrough tap Finish › "Customer withdrew consent: delete the audio" › OK. | On the Finish screen: "The audio was deleted from this iPad. … Type the notes at Finish instead." The notes field appears, nothing uploads, and the outcome goes out as declined. If parts had already uploaded (out of storage, parts upload before Finish), the message names them ("Part 1 was already uploaded: tell the office to delete it."), and a red panel keeps naming each one with its recording ID ("Part 1 was uploaded before the withdrawal …") above every appointment until **I told the office**: follow "Consent withdrawn after upload" below. |
| 19 | Sign in as another employee on the same iPad while something is unsent. | Only "1 walkthrough from another account is waiting" is shown; nothing of theirs is sent. |
| 20 | While recording, open a different appointment from today's list, then tap **Finish** in the bar. | The bar says the walkthrough is for the recorded customer, not the one on screen. Finish switches back to that appointment and opens its Finish screen, which names the customer; the recording continues until Save outcome. |
| 21 | Force a permanent upload refusal (a visit without an exact customer link), open the badge. | The part shows the refusal with Retry upload and Save a copy; after **Save a copy** (saved to Files), **Remove from this iPad** asks to confirm, removes that part, and the next part uploads. |
| 22 | Double-tap **Customer declined recording** (and, on another visit, **Save no-show**). | One walkthrough (one no-show) is saved and sent. |
| 23 | Two tabs: while recording, open Crew home in a new Safari tab (as **Open time clock** does) and open the same walkthrough from the schedule there. | The second tab never asks for the microphone. Its bar reads "Open in another tab" and "This walkthrough is open in another tab on this iPad — use that tab.", with no Finish, Resume or Decide, and its card offers no Finish walkthrough or "Customer withdrew consent"; the first tab keeps recording. Close the first tab (tab overview › ✕): within a few seconds the second tab's bar reads "Recording paused" with "The page closed while recording. The audio saved on this iPad is kept." **Resume** records on; after Finish and Save outcome every part uploads once, with the audio from before the close. |
| 24 | Upload in another tab: in tab A save a recorded walkthrough's outcome offline, go online, and while a part shows "Uploading n%" switch to tab B (Safari pauses tab A) and open the badge there. Stay in tab B for 10 minutes. | Tab B lists the walkthrough with "This walkthrough is open in another tab on this iPad — use that tab." and no Send now, Retry, Save a copy or "Customer withdrew consent". Tab B never sends it: the Action Center shows no second attempt for that part. Switch back to tab A: the upload finishes and, within a few seconds, the walkthrough leaves the Unsent list in both tabs. |
| 25 | Offline, finish a recorded walkthrough (Quote to follow). On its card, tap "Customer withdrew consent: delete the audio" › OK, then go online. | "The audio still on this iPad was deleted (n parts)." Nothing uploads, and the outcome is sent as declined. If parts had already uploaded, the message names them, and they stay named with their recording ID until **I told the office**: follow "Consent withdrawn after upload" below. |
| 26 | In Web Inspector: `await navigator.storage.persisted()` after opening the gameplan (with the recorder switched on). | `true` if Safari granted persistent storage (it is requested once the recorder is switched on or a walkthrough is on the iPad, never while it is switched off, and never on an iPad before iPadOS 15.4). Record the value: if `false`, Safari may evict unsent audio (see Known limits). |
| 27 | Record 5 minutes, go online with a weak signal (one bar, or Settings › Developer › Network Link Conditioner "Very Bad Network"), Save outcome, and while a part shows "Uploading n%" tap "Customer withdrew consent: delete the audio" › OK. | The upload stops. The iPad cannot tell whether an upload it stopped part-way reached the recording service, so (unless the withdrawal came before the part started sending: then "The audio still on this iPad was deleted (1 part)." only) a red panel "…has audio on the recording service although the customer withdrew consent" names "Part n may have reached the recording service before the withdrawal took effect: tell the office (upload ID …)" ("reached … (recording ID …)" when the reply won the race) above every appointment until **I told the office**. In the Action Center check whether the visit has a recording for that part (it may not): either way follow "Consent withdrawn after upload" below. |
| 28 | A tab closed mid-upload: in tab A save a recorded walkthrough's outcome with a weak signal and, while a part shows "Uploading n%", close tab A (tab overview › ✕). Open the gameplan in a new tab. | Within a few seconds the new tab holds the walkthrough and sends the part again under the same upload ID; the Action Center shows it once. Repeat, but turn Airplane mode on before opening the new tab and tap "Customer withdrew consent: delete the audio" › OK there: "Part n may have reached the recording service … (upload ID …)" is named until **I told the office**, and nothing uploads after Airplane mode is off. |
| 29 | Order on return: repeat step 27, but while the part uploads switch to another Safari tab for a minute (Safari pauses the gameplan), then switch back and tap "Customer withdrew consent: delete the audio" › OK at once. | Never a walkthrough that silently leaves the iPad while the Action Center shows a recording for it: either the upload finished first (the walkthrough was sent and cleared before the tap; then follow "Consent withdrawn after upload" by the recording shown in the Action Center), or a red panel names the part ("reached … recording ID" or "may have reached … upload ID") until **I told the office**. |
| 30 | Voice Memos after a withdrawal: after step 25 (a walkthrough whose outcome was sent as recorded, then withdrawn), open that walkthrough again, then close Safari completely, reopen it and open the walkthrough once more. | Each time the card reads "Outcome recorded: …" with no "Upload a Voice Memos file for this walkthrough (.m4a)". Only a rebooked visit whose customer agrees to a new recording (**Recording OK**) offers audio again. |
| 31 | Several walkthroughs of one visit: record and finish a walkthrough (Quote to follow) online and let its audio upload. Turn Airplane mode on, then add two Voice Memos files on its card ("Upload a Voice Memos file for this walkthrough (.m4a)"), one after the other (each becomes its own walkthrough of the visit). Tap "Customer withdrew consent: delete the audio" › OK once, turn Airplane mode off and wait 2 minutes. | One tap covers both files: "The audio still on this iPad was deleted (2 parts). The outcome was already sent as recorded: tell the office the customer withdrew consent." Neither file uploads (the Action Center shows only the recording made before the withdrawal) and the Unsent list empties. Follow "Consent withdrawn after upload" below for the earlier recording. |
| 32 | Signed out on reload: while recording, sign out of the Hub in another tab (or let the session expire), reload the gameplan tab (the sign-in gate shows), then sign in on the gate. | Right after signing in, the bar reads "Recording paused" with "The page closed while recording. The audio saved on this iPad is kept." and **Resume**, never "Open in another tab". |
| 33 | Page ended on screen (iPadOS 15.4+): connect the iPad to a Mac (Safari › Develop › the iPad › the gameplan tab). While recording, with the gameplan on screen, run `window.hog = window.hog || []; for (;;) window.hog.push(new Float64Array(1e7));` in the Web Inspector console (if it stops with an out-of-memory error instead, run it again). WebKit ends the page's process (no pagehide) and Safari reloads the tab ("This webpage was reloaded because a problem occurred"); if it does not reload by itself, tap the page or pull to refresh. | The page's Web Lock went with it: right after the reload the bar reads "Recording paused" with "The page closed while recording. The audio saved on this iPad is kept." and **Resume** and **Finish** (if it first reads "Open in another tab", it must switch within about 5 seconds; note it). Resume records on; repeat the console step once more: the second reload takes it back the same way. After Finish and Save outcome every part uploads once, with the audio from before each reload. |
| 34 | Two walkthroughs: have a second rep start the Synthetic Neighbour walkthrough on their own device (**Recording OK**). On the iPad, while recording Synthetic Customer, open Synthetic Neighbour from today's list ("Started … by …. Record its outcome here.") › **Finish walkthrough**, and add a Voice Memos file there. | The file is refused: "Your walkthrough for Synthetic Customer is still open on this iPad: finish it first, then add this file (or save this outcome first and add the file on its card)." The recording continues. Tap **Save outcome** (Recorded), then add the file on the card ("Upload a Voice Memos file for this walkthrough (.m4a)"): it uploads for that visit, and the bar still shows Synthetic Customer's recording. On Synthetic Customer's Finish screen, "Customer withdrew consent: delete the audio" deletes only that recording. |
| 35 | Part uploaded, outcome waiting, withdrawn in another tab: in tab B record a walkthrough, Save outcome while **not clocked in** so the outcome waits for the timecard decision ("Outcome (Quote to follow) needs your decision"), and let its audio upload. In tab A add a Voice Memos file for the same visit (Airplane mode on, so it stays unsent) and tap "Customer withdrew consent: delete the audio" › OK there. Switch to tab B. | Tab A says the walkthrough is open in another tab, that no upload of it starts, that tab B names any part already uploaded with its recording ID, and to tap "Customer withdrew consent" there. Tab B shows "Part n was uploaded before the withdrawal: tell the office (recording ID …)" with **I told the office**, and offers "Customer withdrew consent: delete the audio". Dismissing the outcome does not remove the walkthrough: it stays until **I told the office**. With only tab B (every part uploaded, outcome waiting), its card offers the withdrawal too, and it names each uploaded part the same way. |
| 36 | An iPad before iPadOS 15.4, only if one is still in use (before updating it, Setup 6): open the walkthrough, tap Start walkthrough, then **Recording OK: record in Voice Memos**, and record the walkthrough in Voice Memos. Pull to refresh the gameplan once. Tap Finish, add the Voice Memos file ("Add the Voice Memos file instead (.m4a)"), choose Quote to follow and Save outcome. | Before Start the card reads "Recording in the Hub needs iPadOS 15.4 or later. Update this iPad in Settings > General > Software Update, or record in Voice Memos and add the file here." There is no plain **Recording OK**, Safari never asks for the microphone, and there is no leave-page prompt. The bar reads "Walkthrough (not recorded)", also after the refresh (never "Open in another tab"). The file uploads and plays back; the outcome is sent as recorded. After an outcome, "Upload a Voice Memos file for this walkthrough (.m4a)" on the card works too. |

## Known limits to confirm

- Parts are separate recordings until FUN-34 stitches them; transcripts and extraction run per part.
- A withdrawal stops the uploads on their way, but the iPad cannot know whether an upload it stopped after the part started
  sending (or one whose page closed or was reloaded mid-upload) reached the recording service: the transport may not have
  handled a completion that already happened. Such a part is always named "may have reached … (upload ID …)", so some of
  these notices name an upload the service never stored; the office checks by upload ID (step 27). Asking the recording
  service by upload ID before naming it is a follow-up (FUN-34). A reply that lands after the rep already told the office
  about that upload ID is not shown again; the office finds it by upload ID.
- The recording service stores the file as `recording` without an extension until FUN-07.
- Two gameplan tabs on one iPad: one tab holds each walkthrough (`session.owner`) from Start until it leaves the iPad, and
  only that tab records, uploads, finishes or withdraws it; every other tab shows "This walkthrough is open in another tab
  on this iPad — use that tab." and changes nothing. Web Locks tell the other tabs when the holding tab is gone (closed,
  reloaded, or discarded by Safari): one of them, or the tab's next page, then takes the walkthrough back with its saved
  audio (steps 14, 23 and 33; should the gone page's lock still be held when it first looks, at its next look about 5
  seconds later), and an upload the gone page had started counts as possibly on the service (step 28). A tab Safari paused
  keeps its Web Lock, so its walkthrough stays with it until the rep switches back to it (step 24). The recorder uses no
  BroadcastChannel and keeps nothing about its tabs in sessionStorage.
- iPads must run iPadOS 15.4+: recording in the Hub needs Web Locks (every iPad that runs iPadOS 15 can update to 15.8).
  Without them a tab cannot tell a paused tab from a closed one, so the recorder records nothing in the Hub, takes no tab
  lock, persistent storage or leave-page prompt, and never takes a walkthrough from another tab. The card says "Recording
  in the Hub needs iPadOS 15.4 or later. Update this iPad in Settings > General > Software Update, or record in Voice Memos
  and add the file here."; **Recording OK: record in Voice Memos** starts the walkthrough without Hub audio (its Start says
  `failed_device`), and the Voice Memos file added at Finish (or on the card after the outcome) is uploaded and the outcome
  sent as recorded (step 36). Whatever such an iPad saves (a walkthrough, a no-show, a Voice Memos file) belongs to no tab,
  so any gameplan tab or later page finishes, withdraws and sends it; each upload keeps its upload ID, so the service keeps
  a part once. A part that a page had on its way when it closed stays counted as possibly on the recording service, and a
  withdrawal names it by its upload ID. A walkthrough a tab holds all the same (saved before the iPad lost Web Locks, or by
  an older build) is never taken or changed there: it is listed as open in another tab, "If that tab is closed, the
  walkthrough is kept on this iPad and sent once this iPad runs iPadOS 15.4 or later.", and while it is open it keeps the
  rep from starting another walkthrough on that iPad. Update the iPad (Setup 6).
- A withdrawal covers the visit: one tap withdraws every walkthrough of the visit that the tab holds (a Hub recording and
  each Voice Memos file, step 31), and the iPad remembers (localStorage, per visit, for every account on it) that the
  customer withdrew consent. From then on no tab starts an upload of any walkthrough of that visit, whichever tab holds it
  or takes it over later and whichever account saved it (its parts read "Not sent: the customer withdrew consent for this
  visit" until the rep withdraws it in that tab), and no Voice Memos file is offered or accepted for it, even after the
  walkthrough left the iPad (step 30), until a rebooked visit's customer taps through **Recording OK** again (then the new
  recording uploads; walkthroughs of the visit already on the iPad stay withdrawn). A withdrawal cannot stop an upload that
  another tab had already started: if it lands, that tab names the part with its recording ID until **I told the office**.
  A part that other tab had uploaded before the withdrawal is named there too (its sync turns it into a notice with its
  recording ID when it next runs), and the walkthrough stays on the iPad until **I told the office**, whether or not the rep
  also withdraws it in that tab (step 35). "Customer withdrew consent" is offered on a walkthrough's card while any of its
  audio is on the iPad or already on the recording service, and the Finish screen's button withdraws the walkthrough on that
  screen (with every other walkthrough of its visit the tab holds), never another open one. A Voice Memos file for a
  walkthrough still open (started on another device) is not accepted while another walkthrough of the rep is open on the
  iPad (step 34), so there is only ever one open walkthrough.
  Another iPad does not know: until FUN-05 records the withdrawal on the visit, the office must not upload audio for a
  visit whose consent was withdrawn.
- Storage eviction: Safari can delete a site's storage when the iPad runs low on space, and (under Intelligent Tracking
  Prevention) after 7 days of Safari use without visiting the site. The recorder asks for persistent storage when it
  opens; Safari decides whether to grant it (step 26). Send, or Save a copy of, any refused part the same day rather than
  leaving audio on the iPad for days.
- Out of storage: when the iPad refuses to keep more audio, seconds are held in page memory, the bar warns, and parts close
  every two minutes and upload as soon as Start is saved. If Safari closes the page meanwhile, the reload says about how
  much audio (only page memory held) was lost.
- The rep's Rescheduled reason is stored on the visit's `walkthroughOutcome.reasonCode`. FUN-02's Dispatch move form asks
  the dispatcher for its own reason for `walkthrough.rescheduled`; offering the stored reason as that form's default is a
  follow-up once FUN-02 and FUN-06 are merged.
- The recording proxy answers `business_session_required` (403) both for an expired Hub session and for an account without
  business access; the recorder shows that message and waits for sign-in. Any other 401 from the recording service (for
  example `invalid_recording_signature`) is shown as a refusal with its code, with Retry upload and Save a copy.
- The gameplan is not in the crew service worker's offline shell (`crew/sw.js` keeps only Today's work), so it cannot be
  reloaded or reopened without signal (step 10). The audio stays in IndexedDB and is sent once the gameplan opens online;
  adding the gameplan shell to the service worker is a follow-up.
- With `EGC_OFFLINE_CLOCK_ENABLED` unset (the default), any Start sent more than 2 minutes after the tap needs the rep's
  timecard decision (step 11). Finish and No-show close the timecard at the server time instead, without asking.
- Uploads go strictly in part order: a refused part holds back the parts after it until it is retried or removed.
- On an iPad without Web Locks (older than iPadOS 15.4) whose storage is refused, a saved outcome's typed notes or an added
  Voice Memos copy live only in page memory; closing the tab loses them (the original file stays in Voice Memos). Update the
  iPad.

## Consent withdrawn after upload (office)

The recorder deletes only what is still on the iPad, and stops uploads on their way. When the rep's message names parts that
were already uploaded, or a red panel names a part that reached (or may have reached) the recording service before the
withdrawal took effect (with its recording ID, or with its upload ID when the iPad cannot tell whether it arrived: the
service may not have it), or the message says the outcome was already sent as recorded:

1. The rep tells the office the same day: customer, visit date, the part numbers and any recording or upload ID from the
   message, then taps **I told the office** (the walkthrough stays on the iPad, above every appointment, until then).
2. The office opens the visit's recordings in the Hub Action Center and does **not** approve their extraction.
3. The recording service has no delete command yet (its commands are list, get, upload, retry, refresh_source and
   approve). Until FUN-34 adds the owner's "delete on customer request" action with an audit entry, the office asks the
   owner to delete those recordings and their transcripts from the recording service's storage by recording ID (for an
   upload ID: the visit's recording uploaded with that request ID, if any), and notes the request and its completion on
   the customer record.
4. If the outcome went out as recorded, the office notes on the customer record that consent was withdrawn, so no one
   quotes from the recording.
