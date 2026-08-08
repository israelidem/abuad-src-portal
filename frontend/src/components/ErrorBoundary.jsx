/**
 * Error boundary.
 *
 * Without one, a render error anywhere unmounts the whole tree and the
 * user gets a blank white page with no explanation. This catches it and
 * offers a way back.
 *
 * Must be a class — React has no hook equivalent for componentDidCatch.
 */

import { Component } from 'react';
import { AlertTriangle } from 'lucide-react';

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Replace with a real error reporter (Sentry et al.) before launch
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4 dark:bg-slate-900">
        <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <AlertTriangle className="mx-auto mb-4 text-amber-500" size={40} />
          <h1 className="mb-2 text-xl font-semibold text-slate-900 dark:text-white">Something went wrong</h1>
          <p className="mb-6 text-sm text-slate-600 dark:text-slate-400">
            The page failed to load. This has been logged — please try again.
          </p>

          {import.meta.env.DEV && (
            <pre className="mb-6 max-h-40 overflow-auto rounded bg-slate-100 p-3 text-left text-xs text-red-700 dark:bg-slate-800 dark:text-red-300">
              {error.message}
            </pre>
          )}

          <div className="flex justify-center gap-3">
            <button
              type="button"
              onClick={this.handleReset}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium hover:bg-slate-50 dark:border-slate-700"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.assign('/')}
              className="rounded-lg bg-[#006633] px-4 py-2 text-sm font-semibold text-white hover:brightness-110"
            >
              Go home
            </button>
          </div>
        </div>
      </div>
    );
  }
}
