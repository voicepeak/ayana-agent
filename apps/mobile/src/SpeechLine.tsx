import { useMemo } from 'react';
import type { Speech } from './types';

const languageTag: Record<string, string> = { ja: 'ja', zh: 'zh-CN', en: 'en' };

function textFor(speech: Speech, language: string) {
  if (language === 'ja') return speech.ja;
  if (language === 'en') return speech.en || speech.zh || speech.ja;
  return speech.zh || speech.ja;
}

export function SpeechLine({ speech, active, primary, translation }: {
  speech: Speech;
  active: boolean;
  primary: string;
  translation: string;
}) {
  const main = textFor(speech, primary);
  const secondary = translation !== 'none' && translation !== primary
    ? textFor(speech, translation)
    : primary !== 'ja' && speech.ja && speech.ja !== main ? speech.ja : '';
  const progress = !active || speech.state === 'played' || !speech.audioEnabled
    ? 1
    : speech.total ? Math.min(1, Math.max(0, speech.played / speech.total)) : 0;
  const glyphs = useMemo(() => Array.from(main), [main]);
  const shown = Math.round(glyphs.length * progress);
  return (
    <div className={`speech-line ${active ? 'is-active' : ''} ${speech.state === 'partial' ? 'is-partial' : ''}`}
         lang={languageTag[primary] || 'zh-CN'}>
      <p className="speech-main" aria-label={main}>
        {glyphs.map((glyph, index) => (
          <span key={index} className={index < shown ? 'is-shown' : ''}>{glyph}</span>
        ))}
      </p>
      {secondary && <p className="speech-secondary" lang={translation !== 'none' ? languageTag[translation] : 'ja'}>{secondary}</p>}
      {speech.state === 'partial' && <small className="speech-interrupted">已打断</small>}
    </div>
  );
}
