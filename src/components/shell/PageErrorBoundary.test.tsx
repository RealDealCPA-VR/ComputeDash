import { act, lazy, Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flush, render } from "../../testing/render";
import { isChunkLoadError, PageErrorBoundary } from "./PageErrorBoundary";

function Broken(): never {
  throw new Error("boom");
}

describe("PageErrorBoundary", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("recognises the browsers' failed dynamic import messages", () => {
    expect(isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: http://x/assets/A-1.js"))).toBe(true);
    expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isChunkLoadError(new TypeError("error loading dynamically imported module"))).toBe(true);
    expect(isChunkLoadError(new Error("boom"))).toBe(false);
  });

  it("shows a reload prompt, not a blank app, when a lazy page's chunk is gone after a redeploy", async () => {
    const Page = lazy(() => Promise.reject(new TypeError("Failed to fetch dynamically imported module: /assets/Page-old.js")));
    const { container } = render(
      <div>
        <nav>shell</nav>
        <PageErrorBoundary resetKey="page">
          <Suspense fallback={<p>loading</p>}>
            <Page />
          </Suspense>
        </PageErrorBoundary>
      </div>
    );
    await flush();
    await flush();
    expect(container.textContent).toContain("shell");
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("sparkDash was updated");
    expect(alert?.querySelector("button")?.textContent).toBe("Reload");
  });

  it("clears the error when the page changes", () => {
    const { container, root } = render(
      <PageErrorBoundary resetKey="a">
        <Broken />
      </PageErrorBoundary>
    );
    expect(container.textContent).toContain("This view could not be shown");
    act(() =>
      root.render(
        <PageErrorBoundary resetKey="b">
          <p>next page</p>
        </PageErrorBoundary>
      )
    );
    expect(container.textContent).toBe("next page");
  });
});
