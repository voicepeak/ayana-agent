# Ayana desktop

Electron main owns the local Python process, authenticated loopback WebSocket,
global shortcuts, tray, window lifecycle and controlled avatar asset proxy.
The isolated React renderers receive a restricted preload bridge. Credentials
and local-service tokens are never returned by that bridge.

Preferences use one sidebar: Appearance & voice, Model & connection, Access & privacy.
Tasks and conversation history form a separate management group. Advanced parameters
and diagnostics are collapsed under Advanced settings. Repository UI, repeated notes
and empty result cards have been removed. Drafts survive navigation and refreshes;
only edited fields are sent, and saving requires a backend persistence receipt.
Access permissions share this save flow. Window controls are expandable on Tasks. See the
[settings and project review](../../docs/SETTINGS_AND_PROJECT_REVIEW_2026-10-06.md)
for the new controls and the isolated Electron regression script.

The companion keeps portrait, dialogue and inline input inside a configurable note.
Its 760px default width uses a roomy side-by-side layout; smaller widths stack the portrait above dialogue.
Background choices are transparent, frosted and a privately stored custom image.
Expandable design controls preview portrait range/size, note width, caption size,
background opacity and subtitle options; Save design persists the draft.
Replies appear in light Noto Serif SC (SimSun fallback), with per-glyph reveal driven by
consumed audio samples, punctuation pauses, at most two lines per shot, and a
brief hold/fade after completion. Silent replies use a matching timed fallback.
Ctrl+Alt+A or clicking the portrait focuses the bare input line; voice/send actions
are revealed with the ellipsis. Enter sends; Shift+Enter inserts a newline, with
input height capped at about two lines. Sending clears the input; Escape
removes focus while preserving unsent drafts. A second Escape hides the note. Right-click the portrait or use the tray
for topics, execution mode, interruption, settings and tasks. Transparent pixels
pass native mouse clicks through; dragging the portrait persists its position.
Settings and optional tool contexts remain in a separate hidden management window.
Only chat owns an AudioWorklet; settings and highlight never create a player.
The catalog indexes all 234 original PNGs (26 expressions, 9 outfit/pose
combinations). The model selects a semantic expression and pose per sentence;
the backend resolves only catalog IDs under the user-selected outfit. A 300ms,
12px dip runs only when the visible expression actually changes; the portrait
holds its current face while the next sentence is generated. Idle and speech never float.

Saving a different outfit immediately creates a short Japanese acknowledgment with
Chinese subtitles through the existing TTS/player pipeline, and shows the companion
without starting another conversation turn. At playback (or text-only presentation),
the new portrait is preloaded, the old one fades into a warm gold shimmer, and the
new outfit appears. Reduced motion switches directly. Saving the same outfit or
other preferences does not trigger a wardrobe reply; startup restores the saved outfit.

The chat renderer hosts the **only** AudioWorklet player. Its bounded queue accepts
mono float32 little-endian PCM, performs linear resampling to the device sample
rate and returns source sample counts plus playback time. Avatar expressions and
live subtitles follow consumption receipts. Queued audio cannot advance the face.
Cancellation clears the Worklet immediately and retains the final consumed
position of an interrupted sentence.

The interface uses published KunUI 2.56.2 `ui-tokens` and `ui-core` packages. Local
React wrappers consume the actual variant, focus, size and radius maps. These
wrappers are not an official KunUI React component package. See
`THIRD_PARTY_NOTICES.md` for upstream source and licensing.

## Develop

From this directory:

```powershell
npm ci
npm run dev
```

The Python backend dependencies must be installed using the root setup script.
`AYANA_PYTHON` overrides its Python executable. Development defaults to the
repository `.venv/Scripts/python.exe`. `AYANA_REPOSITORY_ROOT` overrides the
backend root. The main process captures the original foreground target before
focusing the assistant when summoned with **Ctrl+Alt+A**. **Ctrl+Alt+Space** stops
the current generation. Both shortcuts can be configured in Preferences.
Every summon automatically focuses the question input, including repeated summons,
so typing can begin without clicking the composer.

Hold the microphone button to record up to 15 seconds; release to transcribe.
Recording cancels existing speech and uses half duplex. The microphone permission
is limited to audio capture by the chat renderer.
Recognized text fills the question composer first. Review and correct it, then
press Send; recognition does not automatically submit potentially inaccurate
technical terms to the model.

## Verify and package

```powershell
npm run test
npm run build
```

The root standalone staging script prepares `.runtime/backend` and
`.runtime/python` with a bundled Python runtime, portable backend dependencies,
controlled avatars and an optional speech-recognition model. After staging:

```powershell
npm run package
```

The Windows portable executable is written to `release/`. Personal settings,
credentials and history are deliberately excluded from the package. Packaged
runtime data lives in `%APPDATA%/Ayana`, and its settings can reference the user's
external GPT-SoVITS model environment. The source tree and lockfile remain the
reproducible build inputs. No development machine model path is hardcoded into
the distributed backend defaults.

Portable launches extract into independent NSIS plugin directories. Reopening
the executable while Ayana is already running cannot clean up the active
instance's backend, Python modules or assets. `scripts/verify-portable.mjs`
checks the installed builder's actual NSIS defines before packaging. In builder
26.15.3, `portable.unpackDirName: true` selects this behavior; its type comment
incorrectly describes `false`, which still generates a shared build directory.
