import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { boot, toast } from './state/actions';
import { store } from './state/store';
import { engine } from './audio/engine';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

boot().catch((e) => {
  console.error(e);
  store.set({ ready: true });
  toast(`Startup failed: ${(e as Error).message}`, 'error');
});

// Handy for poking at the app from the devtools console.
Object.assign(window, { whirly: { store, engine } });
