import { useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { sessionOwner } from './api';
import { readLocal, writeLocal } from './storage';

export function useDraft(conversation?: string): [string, Dispatch<SetStateAction<string>>] {
  const key = conversation ? `draft:${sessionOwner()}:${conversation}` : '';
  const [text, setText] = useState('');
  const current = useRef({ key, text, revision: 0 });
  current.current.key = key;
  current.current.text = text;
  useEffect(() => {
    let active = true;
    const revision = ++current.current.revision;
    setText('');
    if (key) void readLocal<string>(key).then(value => {
      if (active && revision === current.current.revision) setText(value || '');
    }).catch(() => {});
    return () => { active = false; };
  }, [key]);
  const update: Dispatch<SetStateAction<string>> = value => {
    const draft = current.current;
    draft.revision++;
    const next = typeof value === 'function' ? value(draft.text) : value;
    draft.text = next;
    setText(next);
    if (draft.key) void writeLocal(draft.key, next).catch(() => {});
  };
  return [text, update];
}
