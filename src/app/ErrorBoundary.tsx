import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = { children: ReactNode };
type State = { hasError: boolean };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Content-free: do not log transcript or filenames.
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <main className="shell">
          <h1>Whisper Transcriber</h1>
          <p role="alert">Something went wrong. Reload the page to start a new session.</p>
          <button type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </main>
      );
    }

    return this.props.children;
  }
}
