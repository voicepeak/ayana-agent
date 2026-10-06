import { useEffect, useState } from 'react';
import type { Speech } from './state';
import { dialogueGlyphs, dialogueRevealCount, dialogueRevealDuration } from './cinematic';
import { dialogueText, dialogueLanguageTag, type DialogueLanguage } from './dialogueLanguages';

/** A sentence keeps the same text nodes when it becomes history. */
export function CinematicDialogue({ speech, primaryLanguage, translationLanguage, textOnly, active = true, show = true, onVisibilityChange }: {
  speech: Speech; primaryLanguage: DialogueLanguage; translationLanguage: 'none' | DialogueLanguage;
  textOnly: boolean; active?: boolean; show?: boolean; onVisibilityChange?: (visible: boolean) => void;
}) {
  const [elapsed, setElapsed] = useState(0);
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const main = dialogueText(speech, primaryLanguage);
  const translation = translationLanguage !== 'none' && translationLanguage !== primaryLanguage ? dialogueText(speech, translationLanguage) : '';
  const timed = textOnly || speech.audioEnabled === false;
  // Translation arrival and language switches never restart the reveal clock.
  const duration = dialogueRevealDuration(speech.ja || main);
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReduced(media.matches);
    media.addEventListener('change', change); return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    if (!active || !timed) return;
    const started = performance.now();
    const interval = setInterval(() => { const next = Math.min(duration, performance.now() - started); setElapsed(next); if (next >= duration) clearInterval(interval); }, 45);
    return () => clearInterval(interval);
  }, [speech.id, timed, active, duration]);
  const progress = !active || speech.state === 'played' ? 1 : timed ? Math.min(1, elapsed / duration) : speech.total ? speech.played / speech.total : 0;
  const mainCount = dialogueRevealCount(main, progress), translatedCount = dialogueRevealCount(translation, progress);
  const visible = show && Boolean(main);
  useEffect(() => { if (active) onVisibilityChange?.(visible); }, [active, visible, onVisibilityChange]);
  return <section className="cinematic-dialogue" aria-label="彩名的台词" lang={dialogueLanguageTag[primaryLanguage]} data-complete={progress >= 1}>
    {show && <>
      <span className="cinematic-accessible" aria-live={active ? 'polite' : 'off'}>{main}</span>
      <div className="cinematic-shot" aria-hidden="true"><p>{dialogueGlyphs(main).map((glyph, index) =>
        <span key={index} className={`cinematic-glyph ${reduced || index < mainCount ? 'is-shown' : ''}`}>{glyph}</span>)}</p></div>
      {!main && <small className="cinematic-translation-pending" role="status">{primaryLanguage === 'en' && speech.enError || `正在准备${primaryLanguage === 'en' ? '英文' : primaryLanguage === 'zh' ? '中文' : '日语'}字幕…`}</small>}
      {translationLanguage !== 'none' && translationLanguage !== primaryLanguage && <p className="cinematic-original" lang={dialogueLanguageTag[translationLanguage]}>
        {translationLanguage === 'en' && !translation && speech.enError}
        {dialogueGlyphs(translation).map((glyph, index) => <span key={index} className={`cinematic-translation-glyph ${reduced || index < translatedCount ? 'is-shown' : ''}`}>{glyph}</span>)}
      </p>}
      {speech.state === 'partial' && <small className="cinematic-interrupted">已打断</small>}
    </>}
  </section>;
}
