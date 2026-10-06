import { useEffect, useRef, useState } from 'react';

/** The appearance window owns this temporary mode; closing it always locks the portrait. */
export function usePortraitEditing(kind: string, designOpen: boolean) {
  const [editing, setEditing] = useState(false);
  const channel = useRef<BroadcastChannel | null>(null);
  const current = useRef({ editing, designOpen });
  current.current = { editing, designOpen };

  useEffect(() => {
    if (kind !== 'chat' && kind !== 'design') return;
    const bus = new BroadcastChannel('ayana-portrait-position');
    channel.current = bus;
    bus.onmessage = ({ data }) => {
      if (kind === 'design' && data?.type === 'request') {
        bus.postMessage({ type: 'state', editing: current.current.designOpen && current.current.editing });
      }
      if (kind === 'chat' && data?.type === 'state') {
        setEditing(current.current.designOpen && data.editing === true);
      }
    };
    return () => { channel.current = null; bus.close(); };
  }, [kind]);

  useEffect(() => {
    if (!designOpen) setEditing(false);
    if (kind === 'design') channel.current?.postMessage({ type: 'state', editing: designOpen && current.current.editing });
    if (kind === 'chat' && designOpen) channel.current?.postMessage({ type: 'request' });
  }, [designOpen, kind]);

  function changeEditing(value: boolean) {
    if (kind !== 'design') return;
    const next = designOpen && value;
    current.current.editing = next;
    setEditing(next);
    channel.current?.postMessage({ type: 'state', editing: next });
  }

  return { portraitEditing: designOpen && editing, changePortraitEditing: changeEditing };
}
