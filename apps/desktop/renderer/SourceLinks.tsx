import { useState } from 'react';
import { Icon } from './components';
import { commandReceipt } from './commandReceipt';

export function sourceLink(source: Record<string, unknown>) {
  if (typeof source.source_id !== 'string' || typeof source.url !== 'string') return null;
  try {
    const url = new URL(source.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return { id: source.source_id, url: url.href, title: String(source.title || url.hostname), host: url.hostname };
  } catch { return null; }
}

/** Shared by the live companion and the inert first-run scene. */
export function SourceLinks({ sources, passive = false }: { sources: Record<string, unknown>[]; passive?: boolean }) {
  const [opening, setOpening] = useState('');
  const [error, setError] = useState('');
  const links = sources.map(sourceLink).filter(item => item !== null);
  if (!links.length) return null;
  async function open(id: string) {
    if (passive || opening) return;
    setOpening(id); setError('');
    try { await commandReceipt({ type: 'source.open', source_id: id }, 'source.opened'); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '网页未打开，请重试。'); }
    finally { setOpening(''); }
  }
  return <nav className="companion-sources" aria-label="网页来源" data-companion-interactive>
    <div className="companion-source-list">{links.map(link => <button key={link.id} type="button" className="companion-source"
      aria-label={`打开网页：${link.title}`} title={`${link.url} · 在默认浏览器打开`} aria-busy={opening === link.id} disabled={!!opening}
      onClick={() => void open(link.id)}><Icon name="search" size={14}/><span><strong>{link.title}</strong><small>{link.host}</small></span><Icon name="external" size={14}/></button>)}</div>
    {error && <p className="companion-source-error" role="alert">{error}</p>}
  </nav>;
}
