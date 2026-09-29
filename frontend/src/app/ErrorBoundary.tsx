import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div role="alert" className="mx-auto max-w-xl px-5 py-16">
          <h1 className="font-serif text-2xl font-semibold">Something went wrong rendering this page</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted">{this.state.error.message}</p>
          <p className="mt-4">
            <a href="/explore" className="text-accent underline decoration-1 underline-offset-2 hover:decoration-2">
              Back to Explore
            </a>
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}
