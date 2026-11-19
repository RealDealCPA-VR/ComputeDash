import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flush, render } from "../../testing/render";
import * as client from "../../api/fleetClient";
import { isOperationRunning, OperationPanel, OPERATION_POLL_MS, operationFromKeys } from "./OperationPanel";
import { makeOperation } from "./fixtures";

vi.mock("../../api/fleetClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/fleetClient")>();
  return { FleetApiError: actual.FleetApiError, isTokenRequiredError: actual.isTokenRequiredError, readOperation: vi.fn(), cancelOperation: vi.fn() };
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function setup(initial = makeOperation(), lost = false) {
  const onUpdate = vi.fn();
  const onFinished = vi.fn();
  const onLost = vi.fn();
  const onDismiss = vi.fn();
  const view = render(
    <OperationPanel
      tracked={{ operation: initial, lost }}
      modelLabel={(k) => `label(${k})`}
      onUpdate={onUpdate}
      onFinished={onFinished}
      onLost={onLost}
      onDismiss={onDismiss}
    />
  );
  return { ...view, onUpdate, onFinished, onLost, onDismiss };
}

const labels = (root: HTMLElement) => Array.from(root.querySelectorAll("button")).map((b) => b.textContent);
const btn = (root: HTMLElement, text: string) => Array.from(root.querySelectorAll("button")).find((b) => b.textContent === text)!;

it("polls every second with since=nextSeq until the operation stops running, then reports it once", async () => {
  const running = makeOperation();
  const done = makeOperation({
    status: "succeeded",
    finishedAt: 2,
    steps: [
      { id: "reach", label: "Confirm target reachable", status: "done", detail: null },
      { id: "start", label: "Start model", status: "done", detail: "listed by /v1/models" },
    ],
  });
  vi.mocked(client.readOperation)
    .mockResolvedValueOnce({ operation: running, lines: [{ seq: 0, text: "loading weights" }], nextSeq: 1 })
    .mockResolvedValueOnce({ operation: running, lines: [{ seq: 1, text: "warming up" }], nextSeq: 2 })
    .mockResolvedValueOnce({ operation: done, lines: [{ seq: 2, text: "ready" }], nextSeq: 3 });
  const { container, onFinished, onUpdate } = setup(running);
  await flush();
  expect(client.readOperation).toHaveBeenNthCalledWith(1, "op-1", undefined);
  await advance(OPERATION_POLL_MS);
  expect(client.readOperation).toHaveBeenNthCalledWith(2, "op-1", 1);
  await advance(OPERATION_POLL_MS);
  expect(client.readOperation).toHaveBeenNthCalledWith(3, "op-1", 2);
  expect(onFinished).toHaveBeenCalledTimes(1);
  expect(onFinished).toHaveBeenCalledWith(done);
  expect(onUpdate).toHaveBeenLastCalledWith(done);
  await advance(OPERATION_POLL_MS * 5);
  expect(client.readOperation).toHaveBeenCalledTimes(3);
  expect(container.querySelector("[role=log]")?.textContent).toBe("loading weights\nwarming up\nready");
  expect(container.querySelector(".mm-op__status")?.textContent).toBe("succeeded");
  expect(container.textContent).toContain("listed by /v1/models");
  expect(container.textContent).toContain("Start label(" + running.modelKey + ")");
  expect(labels(container)).toContain("Dismiss");
  expect(labels(container)).not.toContain("Cancel");
});

it("keeps the last state and retries after a network failure", async () => {
  const running = makeOperation();
  vi.mocked(client.readOperation)
    .mockRejectedValueOnce(new Error("socket hang up"))
    .mockResolvedValue({ operation: running, lines: [], nextSeq: 0 });
  const { container } = setup(running);
  await flush();
  expect(container.textContent).toContain("Lost contact with the operation; retrying. (socket hang up)");
  expect(container.querySelector(".mm-op__status")?.textContent).toBe("running");
  await advance(OPERATION_POLL_MS);
  expect(container.textContent).not.toContain("socket hang up");
  expect(client.readOperation).toHaveBeenCalledTimes(2);
});

it("a 404 marks the operation lost: unknown outcome, Dismiss, unlocks the target, no more polling", async () => {
  const running = makeOperation();
  vi.mocked(client.readOperation)
    .mockResolvedValueOnce({ operation: running, lines: [{ seq: 0, text: "loading" }], nextSeq: 1 })
    .mockRejectedValueOnce(new client.FleetApiError("operation not found", 404));
  const { container, onLost, onFinished, onDismiss } = setup(running);
  await flush();
  await advance(OPERATION_POLL_MS);
  expect(onLost).toHaveBeenCalledTimes(1);
  expect(onLost).toHaveBeenCalledWith(running);
  expect(onFinished).not.toHaveBeenCalled();
  const status = container.querySelector(".mm-op__status")!;
  expect(status.textContent).toBe("status unknown");
  expect(status.textContent).not.toMatch(/succeeded|failed/);
  expect(container.querySelector(".mm-op")?.getAttribute("data-status")).toBe("lost");
  expect(container.textContent).toContain("Its outcome is unknown");
  expect(labels(container)).not.toContain("Cancel");
  await act(async () => btn(container, "Dismiss").click());
  expect(onDismiss).toHaveBeenCalled();
  await advance(OPERATION_POLL_MS * 5);
  expect(client.readOperation).toHaveBeenCalledTimes(2);
  // The page's record no longer counts as running, so controls unlock.
  expect(isOperationRunning({ operation: running, lost: true })).toBe(false);
  expect(isOperationRunning({ operation: running, lost: false })).toBe(true);
});

it("a remounted lost operation is not polled again", async () => {
  const { container } = setup(makeOperation(), true);
  await flush();
  await advance(OPERATION_POLL_MS * 3);
  expect(client.readOperation).not.toHaveBeenCalled();
  expect(container.querySelector(".mm-op__status")?.textContent).toBe("status unknown");
  expect(labels(container)).toContain("Dismiss");
});

it("a 401 pauses polling (one auth prompt) until Retry resumes it", async () => {
  const running = makeOperation();
  vi.mocked(client.readOperation)
    .mockRejectedValueOnce(new client.FleetApiError("token required", 401))
    .mockResolvedValue({ operation: running, lines: [], nextSeq: 0 });
  const { container } = setup(running);
  await flush();
  expect(container.textContent).toContain("Updates paused");
  await advance(OPERATION_POLL_MS * 5);
  expect(client.readOperation).toHaveBeenCalledTimes(1);
  await act(async () => btn(container, "Retry").click());
  await flush();
  expect(client.readOperation).toHaveBeenCalledTimes(2);
  expect(container.textContent).not.toContain("Updates paused");
  await advance(OPERATION_POLL_MS);
  expect(client.readOperation).toHaveBeenCalledTimes(3);
});

it("Cancel asks for confirmation, then calls the cancel endpoint; polling shows the cancelled result", async () => {
  const running = makeOperation();
  vi.mocked(client.readOperation)
    .mockResolvedValueOnce({ operation: running, lines: [], nextSeq: 0 })
    .mockResolvedValueOnce({ operation: makeOperation({ status: "cancelled", finishedAt: 3 }), lines: [], nextSeq: 0 });
  vi.mocked(client.cancelOperation).mockResolvedValue({ cancelled: true });
  const { container, onFinished } = setup(running);
  await flush();
  await act(async () => btn(container, "Cancel").click());
  expect(client.cancelOperation).not.toHaveBeenCalled();
  expect(container.textContent).toContain("Cancel this operation?");
  await act(async () => btn(container, "Keep running").click());
  expect(client.cancelOperation).not.toHaveBeenCalled();
  await act(async () => btn(container, "Cancel").click());
  await act(async () => btn(container, "Cancel operation").click());
  expect(client.cancelOperation).toHaveBeenCalledWith("op-1");
  await advance(OPERATION_POLL_MS);
  expect(container.querySelector(".mm-op__status")?.textContent).toBe("cancelled");
  expect(onFinished).toHaveBeenCalledTimes(1);
});

it("says so when the server refuses to cancel", async () => {
  vi.mocked(client.readOperation).mockResolvedValue({ operation: makeOperation(), lines: [], nextSeq: 0 });
  vi.mocked(client.cancelOperation).mockResolvedValue({ cancelled: false });
  const { container } = setup();
  await flush();
  await act(async () => btn(container, "Cancel").click());
  await act(async () => btn(container, "Cancel operation").click());
  await flush();
  expect(container.textContent).toContain("could not be cancelled");
});

it("shows the server's reason when a cancel is refused, and keeps polling", async () => {
  vi.mocked(client.readOperation).mockResolvedValue({ operation: makeOperation(), lines: [], nextSeq: 0 });
  vi.mocked(client.cancelOperation).mockResolvedValue({ cancelled: false, reason: "the engine is already loading; cancel only works while waiting for readiness" });
  const { container } = setup();
  await flush();
  await act(async () => btn(container, "Cancel").click());
  await act(async () => btn(container, "Cancel operation").click());
  await flush();
  expect(container.textContent).toContain("Cannot cancel now: the engine is already loading; cancel only works while waiting for readiness");
  expect(container.textContent).not.toContain("could not be cancelled at this step");
  const calls = vi.mocked(client.readOperation).mock.calls.length;
  await advance(OPERATION_POLL_MS * 2);
  expect(vi.mocked(client.readOperation).mock.calls.length).toBe(calls + 2);
  expect(labels(container)).toContain("Cancel");
});

it("a cancel refused with 403 token_required shows the token message and tells the page", async () => {
  vi.mocked(client.readOperation).mockResolvedValue({ operation: makeOperation(), lines: [], nextSeq: 0 });
  vi.mocked(client.cancelOperation).mockRejectedValue(new client.FleetApiError("token required", 403, "token_required"));
  const onTokenRequired = vi.fn();
  const view = render(
    <OperationPanel
      tracked={{ operation: makeOperation(), lost: false }}
      modelLabel={(k) => k}
      onUpdate={() => {}}
      onFinished={() => {}}
      onLost={() => {}}
      onDismiss={() => {}}
      onTokenRequired={onTokenRequired}
    />
  );
  await flush();
  await act(async () => btn(view.container, "Cancel").click());
  await act(async () => btn(view.container, "Cancel operation").click());
  await flush();
  expect(view.container.querySelector("[role=alert]")?.textContent).toContain("Model control is disabled until the dashboard has an access token");
  expect(onTokenRequired).toHaveBeenCalledTimes(1);
});

it("disables Cancel with the token reason while control is locked", async () => {
  vi.mocked(client.readOperation).mockResolvedValue({ operation: makeOperation(), lines: [], nextSeq: 0 });
  const view = render(
    <OperationPanel
      tracked={{ operation: makeOperation(), lost: false }}
      modelLabel={(k) => k}
      onUpdate={() => {}}
      onFinished={() => {}}
      onLost={() => {}}
      onDismiss={() => {}}
      controlLocked
    />
  );
  await flush();
  const cancel = btn(view.container, "Cancel");
  expect(cancel.disabled).toBe(true);
  expect(cancel.hasAttribute("aria-description")).toBe(false);
  // The reason is visible text the disabled button points at.
  const reason = document.getElementById(cancel.getAttribute("aria-describedby")!);
  expect(reason?.textContent).toContain("needs a dashboard access token");
  expect(view.container.contains(reason)).toBe(true);
  // Unlocked: no hint.
  const { container } = setup();
  await flush();
  expect(btn(container, "Cancel").disabled).toBe(false);
  expect(btn(container, "Cancel").hasAttribute("aria-describedby")).toBe(false);
});

it("lists every model a switch stops (fromModelKeys), falling back to fromModelKey", async () => {
  vi.mocked(client.readOperation).mockImplementation(() => new Promise(() => {}));
  const op = makeOperation({ action: "switch", modelKey: "new", fromModelKey: "a", fromModelKeys: ["a", "b"] });
  expect(operationFromKeys(op)).toEqual(["a", "b"]);
  expect(operationFromKeys(makeOperation({ fromModelKey: "a" }))).toEqual(["a"]);
  expect(operationFromKeys(makeOperation({ fromModelKey: null, fromModelKeys: [] }))).toEqual([]);
  const { container } = setup(op);
  await flush();
  expect(container.querySelector(".mm-op__sub")?.textContent).toBe("Replacing label(a), label(b)");
});

it("stops polling when unmounted", async () => {
  vi.mocked(client.readOperation).mockResolvedValue({ operation: makeOperation(), lines: [], nextSeq: 0 });
  const { root } = setup();
  await flush();
  act(() => root.unmount());
  await advance(OPERATION_POLL_MS * 3);
  expect(client.readOperation).toHaveBeenCalledTimes(1);
});

it("re-opened on a finished operation only fetches its log and does not report it again", async () => {
  const done = makeOperation({ status: "failed", error: "readiness timed out after 600 s" });
  vi.mocked(client.readOperation).mockResolvedValue({ operation: done, lines: [{ seq: 0, text: "x" }], nextSeq: 1 });
  const { container, onFinished } = setup(done);
  await flush();
  expect(onFinished).not.toHaveBeenCalled();
  expect(container.querySelector("[role=alert]")?.textContent).toContain("readiness timed out after 600 s");
});

it("a 404 on an already-finished operation keeps its final status and does not mark it lost", async () => {
  const done = makeOperation({ status: "failed", error: "readiness timed out" });
  vi.mocked(client.readOperation).mockRejectedValue(new client.FleetApiError("operation not found", 404));
  const { container, onLost } = setup(done);
  await flush();
  await advance(OPERATION_POLL_MS * 3);
  expect(client.readOperation).toHaveBeenCalledTimes(1);
  expect(onLost).not.toHaveBeenCalled();
  expect(container.querySelector(".mm-op__status")?.textContent).toBe("failed");
  expect(container.querySelector(".mm-op")?.getAttribute("data-status")).toBe("failed");
  expect(container.textContent).not.toContain("Its outcome is unknown");
  expect(labels(container)).toContain("Dismiss");
});

it("offers Retry after a 401 on a re-opened finished operation, and Retry fetches its log", async () => {
  const done = makeOperation({ status: "succeeded", finishedAt: 2 });
  vi.mocked(client.readOperation)
    .mockRejectedValueOnce(new client.FleetApiError("token required", 401))
    .mockResolvedValueOnce({ operation: done, lines: [{ seq: 0, text: "ready" }], nextSeq: 1 });
  const { container } = setup(done);
  await flush();
  expect(labels(container)).toContain("Retry");
  expect(labels(container)).toContain("Dismiss");
  await act(async () => btn(container, "Retry").click());
  await flush();
  expect(client.readOperation).toHaveBeenCalledTimes(2);
  expect(container.querySelector("[role=log]")?.textContent).toBe("ready");
  expect(labels(container)).not.toContain("Retry");
});
