import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.js';
import './styles.css';

interface ErrorBoundaryState {
  failed: boolean;
}

class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Local console only: the project intentionally has no telemetry or remote crash reporting.
    console.error('CrossEx UI failed to render', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <main className="fatal-error" role="alert">
      <div>
        <p>星闪量化 FlareStar Quant · Gate CrossEx</p>
        <h1>The interface could not be loaded.</h1>
        <span>Your local backend and trading strategies may still be running. Reload the page; if the problem continues, run <code>./run doctor</code> and inspect <code>./run logs</code>.</span>
        <button onClick={() => window.location.reload()}>Reload interface</button>
      </div>
    </main>;
  }
}

const root = document.getElementById('root');
if (!root) throw new Error('Application root element is missing');

createRoot(root).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
