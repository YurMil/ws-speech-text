import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { AppMinimal } from './app/AppMinimal';
import { ErrorBoundary } from './app/ErrorBoundary';

const uiMode = localStorage.getItem('ui-mode') ?? 'minimal';

if (uiMode === 'classic') {
  import('./styles/app.css');
} else {
  import('./styles/minimal.css');
  document.body.classList.add('minimal-ui');
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      {uiMode === 'classic' ? <App /> : <AppMinimal />}
    </ErrorBoundary>
  </StrictMode>,
);
