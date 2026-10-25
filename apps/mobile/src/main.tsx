import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './floating.css';
import { Capacitor } from '@capacitor/core';

createRoot(document.getElementById('root')!).render(<App />);

if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext && !Capacitor.isNativePlatform()) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(new URL('sw.js', document.baseURI).href).catch(() => {});
  });
}
