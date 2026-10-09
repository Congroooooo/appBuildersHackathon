import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter/wght.css';
import { App } from './App';
import { initTheme } from './theme';
import './styles.css';

initTheme();
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
