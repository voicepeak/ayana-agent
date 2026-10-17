import { useEffect, useRef, useState } from 'react';
import { bridge } from './state';
import { HoldRecorder, type CaptureState } from './holdRecorder';

export function useHoldToTalk(enabled: boolean, conversation: string | undefined, onTranscript: (text: string) => void) {
  const [status, setStatus] = useState<CaptureState>('idle');
  const [error, setError] = useState('');
  const recorder = useRef<HoldRecorder | undefined>(undefined);
  const latestId = useRef<string | undefined>(undefined);
  const pointerHeld = useRef(false);
  const callback = useRef(onTranscript); callback.current = onTranscript;
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const capture = new HoldRecorder({
      getStream: () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false }),
      makeRecorder: stream => new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 64000 }),
      submit: async (id, data, mime) => {
        const result = await bridge.send({ type: 'input.audio', request_id: id, audio_base64: data, mime_type: mime });
        if (!result.ok) throw new Error(result.error || '语音未发送，请重试。');
      },
      state: value => { if (!disposed) setStatus(value); },
      error: message => { if (!disposed) { setError(message); const id = latestId.current; if (id) void bridge.endTalk(id, true); } },
    });
    recorder.current = capture;
    const cancel = () => { const id = latestId.current; latestId.current = undefined; if (id) void bridge.endTalk(id, true); capture.cancel(); };
    const off = bridge.onEvent(event => {
      if (event.type === 'desktop.talk-started') {
        const id = String(event.hold_id); latestId.current = id; setError(''); void capture.start(id);
      }
      if (event.type === 'desktop.talk-ended') capture.release(String(event.hold_id), event.cancelled === true);
      if (event.type === 'input.transcribed' && event.request_id === latestId.current) {
        latestId.current = undefined; setStatus('idle');
        if (typeof event.text === 'string' && event.text.trim()) callback.current(event.text.trim());
      }
      if (event.type === 'input.state' && event.state === 'failed' && latestId.current) { latestId.current = undefined; setStatus('failed'); setError('语音识别失败，请检查语音设置。'); }
      if (event.type === 'desktop.hidden' || event.type === 'desktop.reset' || event.type === 'desktop.cancelled' || event.type === 'conversation.changed'
        || (event.type === 'desktop.service' && event.connected === false)) cancel();
    });
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !latestId.current) return;
      event.preventDefault(); event.stopImmediatePropagation(); cancel();
      void bridge.send({ type: 'generation.cancel' });
    };
    window.addEventListener('keydown', escape, true);
    return () => { disposed = true; off(); window.removeEventListener('keydown', escape, true); cancel(); recorder.current = undefined; };
  }, [enabled]);
  useEffect(() => {
    const id = latestId.current;
    if (id) { latestId.current = undefined; void bridge.endTalk(id, true); recorder.current?.cancel(); }
  }, [conversation]);
  return { status, error, dismissError: () => setError(''),
    press: async () => {
      pointerHeld.current = true;
      try {
        const result = await bridge.beginTalk();
        if (result.ok && result.hold_id && !pointerHeld.current) void bridge.endTalk(result.hold_id);
      } catch { setError('暂时无法开始录音，请重试。'); }
    },
    release: (cancelled = false) => { pointerHeld.current = false; const id = latestId.current; if (id) void bridge.endTalk(id, cancelled); },
  };
}
