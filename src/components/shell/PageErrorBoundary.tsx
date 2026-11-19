import { Component, useState, type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

/**
 * A lazily loaded chunk that could not be fetched. After a redeploy an open tab still references
 * the old content-hashed chunks, which no longer exist; a reload picks up the new build.
 */
export function isChunkLoadError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /dynamically imported module|importing a module script failed|unable to preload css|chunkloaderror|failed to load module script/i.test(text);
}

function reloadPage() {
  try {
    window.location.reload();
  } catch {
    /* environments without navigation (jsdom) */
  }
}

interface PageErrorBoundaryProps {
  /** A change (e.g. the page id) clears the error, so navigating away from a failed page works. */
  resetKey?: unknown;
  /** Floating: a corner notice instead of an in-page panel (for dialogs outside the page). */
  floating?: boolean;
  children: ReactNode;
}

interface PageErrorBoundaryState {
  error: unknown;
  failed: boolean;
}

/**
 * Keeps the shell alive when a page (or its code chunk) fails: shows a "reload to update" notice
 * instead of unmounting the whole app.
 */
export class PageErrorBoundary extends Component<PageErrorBoundaryProps, PageErrorBoundaryState> {
  state: PageErrorBoundaryState = { error: null, failed: false };

  static getDerivedStateFromError(error: unknown): PageErrorBoundaryState {
    return { error, failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("[sparkDash] view failed to render:", error, info.componentStack);
  }

  componentDidUpdate(prev: PageErrorBoundaryProps) {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) this.setState({ error: null, failed: false });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <PageError chunk={isChunkLoadError(this.state.error)} floating={this.props.floating === true} />;
  }
}

function PageError({ chunk, floating }: { chunk: boolean; floating: boolean }) {
  const { t } = useTranslation("shell");
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <div className={`panel page-error${floating ? " page-error--floating" : ""}`} role="alert">
      <h2 className="text-sm font-semibold text-text-strong">{chunk ? t("pageError.updatedTitle") : t("pageError.title")}</h2>
      <p className="mt-1 text-xs text-muted">{chunk ? t("pageError.updatedDetail") : t("pageError.detail")}</p>
      <div className="page-error__actions">
        <button type="button" className="btn btn--primary" onClick={reloadPage}>
          {t("pageError.reload")}
        </button>
        {floating ? (
          <button type="button" className="btn btn--ghost" onClick={() => setDismissed(true)}>
            {t("error.dismiss")}
          </button>
        ) : null}
      </div>
    </div>
  );
}
