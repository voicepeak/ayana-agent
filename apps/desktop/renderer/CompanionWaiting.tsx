import { useEffect, useState } from 'react';
import type { ModelState } from './state';
import { bridge } from './state';
import { waitingActivity, waitingDuration } from './waitingActivity';
import './companion-waiting.css';

export function CompanionWaiting({ state }: { state: ModelState }) {
  const activity = waitingActivity(state);
  const [now, setNow] = useState(Date.now);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState('');
  const [phase, setPhase] = useState(() => ({ key: activity.key, since: Date.now() }));
  const question = state.questions.at(-1);
  const [fallbackStart] = useState(Date.now);
  const startedAt = question?.startedAt ?? fallbackStart;
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => { setPhase({ key: activity.key, since: Date.now() }); }, [activity.key]);
  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));
  const takingLonger = phase.key === activity.key && now - phase.since >= 30000;
  async function stop() {
    setStopping(true); setStopError('');
    try {
      const result = await bridge.send({ type: 'generation.cancel' });
      if (!result.ok) { setStopError(result.error || '停止请求未完成，请再试一次。'); setStopping(false); }
    } catch { setStopError('停止请求未完成，请再试一次。'); setStopping(false); }
  }
  return <div className="cinematic-waiting companion-waiting" data-stage={activity.stage} data-long={takingLonger}>
    <div className="waiting-motion" aria-hidden="true">
      <span/><span/><span/>
    </div>
    <div className="waiting-copy">
      <div className="waiting-message" role="status" aria-live="polite" aria-atomic="true">
        <p className="waiting-title">在终之空游荡中...</p>
        <p className="waiting-detail">{takingLonger ? '还需要一点时间。结果还没回来。' : activity.detail}</p>
      </div>
      <div className="waiting-controls">
        <span className="waiting-time" aria-live="off">已等 {waitingDuration(elapsed)}</span>
        <button type="button" className="waiting-stop" disabled={stopping} onClick={() => void stop()}>{stopping ? '正在停止…' : '停止'}</button>
      </div>
      {stopError && <p className="waiting-detail" role="alert">{stopError}</p>}
    </div>
  </div>;
}
