import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { ErrorBoundary } from './app/ErrorBoundary';
// Imported statically so the bundler links the stylesheet from the entry
// document. A dynamic import would defer it behind the JS chunk and leave the
// first paint unstyled — most visible on the mobile connections this app
// targets.
import './styles/app.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
