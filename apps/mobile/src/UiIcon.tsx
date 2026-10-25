export function UiIcon({ name, size = 20 }: { name: 'close' | 'restore' | 'minimize' | 'send' | 'stop' | 'resize'; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {name === 'close' && <path d="m6 6 12 12M18 6 6 18" />}
    {name === 'restore' && <><path d="M14 4h6v6M20 4 10 14" /><path d="M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5" /></>}
    {name === 'minimize' && <path d="M5 12h14" />}
    {name === 'send' && <path d="M12 20V4m-6 6 6-6 6 6" />}
    {name === 'stop' && <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" />}
    {name === 'resize' && <path d="m10 18 8-8m-3 8 3-3" />}
  </svg>;
}
