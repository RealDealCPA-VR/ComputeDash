import { act } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flush, render } from "../../testing/render";
import * as client from "../../api/fleetClient";
import { setLocale } from "../../i18n";
import { ModelsPage } from "./ModelsPage";
import { DESK, DUO, SERVING, SPARK1, SPARK2, makeInventory } from "./fixtures";

vi.mock("../../api/fleetClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/fleetClient")>();
  return {
    FleetApiError: actual.FleetApiError,
    isBusyError: actual.isBusyError,
    isTokenRequiredError: actual.isTokenRequiredError,
    isRoutingDisabledError: actual.isRoutingDisabledError,
    getRouting: vi.fn(),
    resolveRoute: vi.fn(),
    listRoutedModels: vi.fn(),
    getFleetStatus: vi.fn(),
    getTargets: vi.fn(),
    getInventory: vi.fn(),
    startOperation: vi.fn(),
    readOperation: vi.fn(),
    cancelOperation: vi.fn(),
    getLogs: vi.fn(),
    listClusters: vi.fn(),
    createCluster: vi.fn(),
    updateCluster: vi.fn(),
    deleteCluster: vi.fn(),
  };
});

beforeEach(() => {
  vi.mocked(client.getFleetStatus).mockResolvedValue({ enabled: true, smartRoutingEnabled: false, adapters: [] });
  vi.mocked(client.getTargets).mockResolvedValue({ targets: [SPARK1, SPARK2, DUO, DESK], generatedAt: 1 });
  vi.mocked(client.getInventory).mockResolvedValue(makeInventory({ stale: true }));
});

afterEach(async () => {
  await act(async () => setLocale("en"));
  vi.clearAllMocks();
});

it("renders in Simplified Chinese and keeps model names and ids untranslated, without refetching", async () => {
  const { container } = render(<ModelsPage />);
  await flush();
  await flush();
  expect(container.querySelector("h1")?.textContent).toBe("Models");
  const calls = () => vi.mocked(client.getInventory).mock.calls.length + vi.mocked(client.getTargets).mock.calls.length;
  const before = calls();
  await act(async () => setLocale("zh-CN"));
  expect(container.querySelector("h1")?.textContent).toBe("模型");
  expect(container.querySelector(".mm-routing-chip")?.textContent).toBe("智能路由：关");
  expect(container.textContent).toContain("分布式集群");
  expect(container.textContent).toContain("可视分组");
  expect(container.textContent).toContain("此清单来自缓存");
  const servingRow = container.querySelector(`tr[data-model-key="${SERVING.modelKey}"]`)!;
  expect(servingRow.textContent).toContain("qwen3-32b");
  expect(servingRow.querySelector(".mm-state")?.textContent).toBe("服务中");
  expect(container.querySelector('tr[data-model-key="vllm|8000|m-unknown"] .mm-state')?.textContent).toBe("未知");
  expect(container.querySelector('tr[data-model-key="vllm|9000|deepseek-v3"]')?.textContent).toContain("由 Spark Duo 提供服务");
  expect(Array.from(container.querySelectorAll("button")).map((b) => b.textContent)).toContain("切换模型");
  // No raw keys leak.
  expect(container.textContent).not.toMatch(/\b(state|targets|models|table|actions|inventory|routing)\.[a-z]/);
  expect(calls()).toBe(before);
});
