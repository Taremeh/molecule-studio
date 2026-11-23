import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/global.css';
import App from './App';
import { useStore } from './state/store';
import { getViewer } from './render/viewerApi';

// Debug handles (useful from the browser console).
(window as any).__store = useStore;
(window as any).__viewer = getViewer;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
