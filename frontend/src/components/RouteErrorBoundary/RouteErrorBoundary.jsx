import { Component } from 'react';
import Alert from '../Alert/Alert.jsx';

export default class RouteErrorBoundary extends Component {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="container page">
          <Alert title="This page couldn't load">
            Check your connection and reload the page to try again.
            <button type="button" className="btn btn--ghost btn--sm alert__retry" onClick={() => window.location.reload()}>
              Reload page
            </button>
          </Alert>
        </main>
      );
    }

    return this.props.children;
  }
}