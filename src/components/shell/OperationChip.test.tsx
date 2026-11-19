import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FleetOperation } from "../../api/fleetTypes";
import { flush, render } from "../../testing/render";

vi.mock("../../api/fleetClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/fleetClient")>();
  return { ...actual, listOperations: vi.fn() };
});

import { FleetApiError, listOperations } from "../../api/fleetClient";
import { OperationChip, OPERATION_CHIP_POLL_MS } from "./OperationChip";
import { resetActiveOperationsCache } from "../FleetBoard/useActiveOperations";
import { clearToken, setToken } from "../../api/authToken";

const list = vi.mocked(listOperations);

function op(over: Partial<FleetOperation> = {}): FleetOperation {
  return {
    id: "op1",
    targetId: "node:a",
    action: "switch",
    modelKey: "vllm|8000|qwen3-32b",
    fromModelKey: null,
    status: "running",
    step: "start",
    steps: [
      { id: "stop", label: "Stop", status: "done", detail: null },
      { id: "start", label: "Start", status: "running", detail: null },
      { id: "wait", label: "Wait", status: "pending", detail: null },
    ],
    startedAt: 0,
    finishedAt: null,
    error: null,
    ...over,
  };
}

const nameOf = (id: string) => (id === "node:a" ? "Spark A" : id);

beforeEach(() => {
  resetActiveOperationsCache();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  clearToken();
});

describe("OperationChip", () => {
  it("names the running operation, its target and step, and links to the Models page", async () => {
    list.mockResolvedValue({ operations: [op(), op({ id: "op2", targetId: "node:b" })] });
    const onOpen = vi.fn();
    const { container } = render(<OperationChip enabled nameOf={nameOf} onOpen={onOpen} />);
    await flush();
    const link = container.querySelector<HTMLAnchorElement>("a.op-chip")!;
    expect(link.textContent).toContain("Switching qwen3-32b on Spark A — step 2/3");
    expect(link.textContent).toContain("+1 more");
    expect(link.getAttribute("href")).toBe("/models?target=node%3Aa");
    act(() => link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
    expect(onOpen).toHaveBeenCalledWith("node:a");
    expect(list).toHaveBeenCalledWith(true);
  });

  it("is quiet with nothing running and polls every 5 s; nothing at all while disabled", async () => {
    list.mockResolvedValue({ operations: [] });
    const { container } = render(<OperationChip enabled nameOf={nameOf} onOpen={() => {}} />);
    await flush();
    expect(container.textContent).toBe("");
    await act(async () => vi.advanceTimersByTime(OPERATION_CHIP_POLL_MS));
    expect(list).toHaveBeenCalledTimes(2);

  });

  it("does not poll while the fleet feature is off", async () => {
    list.mockResolvedValue({ operations: [op()] });
    const { container } = render(<OperationChip enabled={false} nameOf={nameOf} onOpen={() => {}} />);
    await act(async () => vi.advanceTimersByTimeAsync(OPERATION_CHIP_POLL_MS * 3));
    expect(list).not.toHaveBeenCalled();
    expect(container.textContent).toBe("");
  });

  it("stays quiet and stops polling when an older server has no endpoint (404)", async () => {
    list.mockRejectedValue(new FleetApiError("Not found", 404));
    const { container } = render(<OperationChip enabled nameOf={nameOf} onOpen={() => {}} />);
    await flush();
    await act(async () => vi.advanceTimersByTime(OPERATION_CHIP_POLL_MS * 3));
    expect(container.textContent).toBe("");
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when the server refuses the request (401/403)", async () => {
    list.mockResolvedValueOnce({ operations: [op()] }).mockRejectedValue(new FleetApiError("Forbidden", 403));
    const { container } = render(<OperationChip enabled nameOf={nameOf} onOpen={() => {}} />);
    await flush();
    expect(container.textContent).toContain("Switching");
    await act(async () => vi.advanceTimersByTime(OPERATION_CHIP_POLL_MS));
    await flush();
    expect(container.textContent).toBe("");
  });

  it("stops polling after 401/403 and resumes once a new access token is saved", async () => {
    list.mockRejectedValue(new FleetApiError("Authentication required", 401));
    const { container } = render(<OperationChip enabled nameOf={nameOf} onOpen={() => {}} />);
    await flush();
    await act(async () => vi.advanceTimersByTime(OPERATION_CHIP_POLL_MS * 3));
    expect(list).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("");
    list.mockResolvedValue({ operations: [op()] });
    act(() => setToken("new-token"));
    await flush();
    expect(list).toHaveBeenCalledTimes(2);
    expect(container.querySelector("a.op-chip")?.textContent).toContain("Switching");
  });

  it("announces only when an operation starts or finishes, not on every step", async () => {
    list.mockResolvedValue({ operations: [] });
    const { container } = render(<OperationChip enabled nameOf={nameOf} onOpen={() => {}} />);
    await flush();
    const status = () => container.querySelector('[role="status"]');
    expect(status()?.textContent).toBe("");
    // The link itself is no live region.
    list.mockResolvedValue({ operations: [op()] });
    await act(async () => vi.advanceTimersByTime(OPERATION_CHIP_POLL_MS));
    await flush();
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(container.querySelector("a.op-chip [role=status]")).toBeNull();
    expect(status()?.textContent).toBe("Switching qwen3-32b on Spark A");
    // Next step: the chip shows it, the live region stays unchanged.
    list.mockResolvedValue({ operations: [op({ step: "wait", steps: op().steps.map((s) => ({ ...s, status: s.id === "wait" ? "running" : "done" })) })] });
    await act(async () => vi.advanceTimersByTime(OPERATION_CHIP_POLL_MS));
    await flush();
    expect(container.querySelector("a.op-chip")?.textContent).toContain("step 3/3");
    expect(status()?.textContent).toBe("Switching qwen3-32b on Spark A");
    list.mockResolvedValue({ operations: [] });
    await act(async () => vi.advanceTimersByTime(OPERATION_CHIP_POLL_MS));
    await flush();
    expect(container.querySelector("a.op-chip")).toBeNull();
    expect(status()?.textContent).toBe("Model operation on Spark A finished");
  });
});
