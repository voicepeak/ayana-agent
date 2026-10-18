import { createRoot } from 'react-dom/client';
import App from './App';
import { Welcome } from './Welcome';
import './styles.css';
import './companion-frame.css';
import './image-mode.css';
import './settings.css';

createRoot(document.getElementById('root')!).render(new URLSearchParams(location.search).get('window') === 'welcome' ? <Welcome/> : <App/>);
