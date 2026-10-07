import { useState } from 'react';
import type { ModelState } from './state';
import { bridge } from './state';
import { waitingActivity } from './waitingActivity';
import './companion-waiting.css';

export function CompanionWaiting({ state }: { state: ModelState }) {
  const activity = waitingActivity(state);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState('');
  async function stop() {
    setStopping(true); setStopError('');
    try {
      const result = await bridge.send({ type: 'generation.cancel' });
      if (!result.ok) { setStopError(result.error || '停止请求未完成，请再试一次。'); setStopping(false); }
    } catch { setStopError('停止请求未完成，请再试一次。'); setStopping(false); }
  }
  return <div className="cinematic-waiting companion-waiting" data-stage={activity.stage}>
    <div className="waiting-motion" aria-hidden="true">
      <span/><span/><span/>
    </div>
    <div className="waiting-copy">
      <div className="waiting-message" role="status" aria-live="polite" aria-atomic="true">
        <p className="waiting-title">在终之空游荡中...</p>
        <p className="waiting-detail">{activity.detail}</p>
      </div>
      <div className="waiting-controls">
        <button type="button" className="waiting-stop" disabled={stopping} onClick={() => void stop()}>{stopping ? '正在停止…' : '停止'}</button>
      </div>
      {stopError && <p className="waiting-detail" role="alert">{stopError}</p>}
    </div>
  </div>;
}
