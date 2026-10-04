# Ayana desktop

Electron main owns the local Python process, authenticated loopback WebSocket,
global shortcuts, tray, window lifecycle and controlled avatar asset proxy.
The isolated React renderers receive a restricted preload bridge. Credentials
and local-service tokens are never returned by that bridge.

The summoned chat is a single frameless, transparent companion window: a half
portrait above Japanese dialogue and Chinese translation. Settings and optional
tool contexts live in a separate hidden window, opened through the gear or tray.
Only chat owns an AudioWorklet; settings and highlight never create a player.
The catalog indexes all 234 original PNGs (26 expressions, 9 outfit/pose
combinations). The model selects a semantic expression and pose per sentence;
the backend resolves only catalog IDs under the user-selected outfit. A 300ms,
12px dip runs once when a sentence becomes visible. Idle and speech never float.

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
