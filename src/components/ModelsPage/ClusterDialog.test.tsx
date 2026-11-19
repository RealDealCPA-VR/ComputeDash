import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flush, render } from "../../testing/render";
import * as client from "../../api/fleetClient";
import type { FleetCluster } from "../../api/fleetTypes";
import { ClusterDialog, EMPTY_DRAFT, clusterInputFromDraft, validateClusterDraft } from "./ClusterDialog";
import { MAC, SPARK1, SPARK2 } from "./fixtures";

vi.mock("../../api/fleetClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/fleetClient")>();
  return {
    FleetApiError: actual.FleetApiError,
    isBusyError: actual.isBusyError,
    listClusters: vi.fn(),
    createCluster: vi.fn(),
    updateCluster: vi.fn(),
    deleteCluster: vi.fn(),
  };
});

const DUO: FleetCluster = {
  id: "duo",
  name: "Spark Duo",
  kind: "distributed",
  memberIds: ["spark1", "spark2"],
  headId: "spark1",
  endpoint: { host: null, port: 8000 },
  engine: "vllm",
  launcherId: "vllm-ray",
  notes: "",
};
const SUGGESTED: FleetCluster = { ...DUO, id: "spark1-cluster", name: "spark1 cluster", launcherId: null };

beforeEach(() => {
  vi.mocked(client.listClusters).mockResolvedValue({ clusters: [DUO], suggestions: [SUGGESTED] });
  vi.mocked(client.createCluster).mockImplementation(async (input) => ({ cluster: { ...DUO, ...input, id: input.id ?? "new" } }));
  vi.mocked(client.updateCluster).mockResolvedValue({ cluster: DUO });
  vi.mocked(client.deleteCluster).mockResolvedValue({ removed: true });
});

afterEach(() => vi.clearAllMocks());

const dialog = () => document.body.querySelector<HTMLElement>("[role=dialog]")!;
function button(text: string): HTMLButtonElement {
  const found = Array.from(dialog().querySelectorAll("button")).find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`no button ${text}`);
  return found;
}
async function click(el: HTMLElement) {
  await act(async () => el.click());
  await flush();
}
function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}
const byLabel = (text: string) => {
  const label = Array.from(dialog().querySelectorAll("label")).find((l) => l.textContent === text)!;
  return dialog().querySelector<HTMLInputElement>(`#${CSS.escape(label.htmlFor)}`)!;
};

async function open() {
  const onChanged = vi.fn();
  const onClose = vi.fn();
  render(<ClusterDialog open nodes={[SPARK1, SPARK2, MAC]} onClose={onClose} onChanged={onChanged} />);
  await flush();
  await flush();
  return { onChanged, onClose };
}

describe("validateClusterDraft", () => {
  const ok = { ...EMPTY_DRAFT, name: "Duo", memberIds: ["a", "b"], headId: "a", port: "8000" };
  it("accepts a valid distributed cluster", () => {
    expect(validateClusterDraft(ok)).toEqual([]);
  });
  it("needs a name, two members and the head among them", () => {
    expect(validateClusterDraft({ ...ok, name: " " })).toContain("name");
    expect(validateClusterDraft({ ...ok, memberIds: ["a"] })).toContain("members");
    expect(validateClusterDraft({ ...ok, memberIds: ["a", "a"] })).toEqual(expect.arrayContaining(["members", "duplicateMembers"]));
    expect(validateClusterDraft({ ...ok, headId: "c" })).toContain("head");
    expect(validateClusterDraft({ ...ok, headId: "" })).toContain("head");
  });
  it("checks the port range only for a distributed cluster", () => {
    for (const port of ["", "0", "65536", "80.5", "-1", "abc"]) expect(validateClusterDraft({ ...ok, port })).toContain("port");
    for (const port of ["1", "65535"]) expect(validateClusterDraft({ ...ok, port })).toEqual([]);
    expect(validateClusterDraft({ ...ok, kind: "group", port: "" })).toEqual([]);
  });
  it("builds a body: a group has no endpoint; an empty host means the head's host", () => {
    expect(clusterInputFromDraft({ ...ok, host: " ", engine: "vllm" }, false)).toEqual({
      name: "Duo",
      kind: "distributed",
      memberIds: ["a", "b"],
      headId: "a",
      endpoint: { host: null, port: 8000 },
      engine: "vllm",
      launcherId: null,
      notes: "",
    });
    const group = clusterInputFromDraft({ ...ok, kind: "group", engine: "vllm", id: "desk" }, true);
    expect(group.endpoint).toBeNull();
    expect(group.engine).toBeNull();
    expect(group.id).toBe("desk");
  });
});

describe("ClusterDialog", () => {
  it("lists clusters and suggestions, labelled by kind", async () => {
    await open();
    const text = dialog().textContent!;
    expect(text).toContain("Spark Duo");
    expect(text).toContain("Distributed cluster");
    expect(text).toContain("Members: Spark 1, Spark 2 · head: Spark 1");
    expect(text).toContain("Endpoint: head host:8000");
    expect(text).toContain("Suggestions");
    expect(text).toContain("spark1 cluster");
  });

  it("validates the form before creating, then creates and reports the change", async () => {
    const { onChanged } = await open();
    await click(button("New cluster"));
    await click(button("Save cluster"));
    expect(client.createCluster).not.toHaveBeenCalled();
    const errors = Array.from(dialog().querySelectorAll(".mm-validation li")).map((li) => li.textContent);
    expect(errors).toEqual(["Enter a name.", "Choose at least two member nodes.", "The head node must be one of the members.", "A distributed cluster needs a port from 1 to 65535."]);

    await act(async () => setValue(byLabel("Name"), "Lab pair"));
    const boxes = Array.from(dialog().querySelectorAll<HTMLInputElement>("input[type=checkbox]"));
    await click(boxes[0]);
    await click(boxes[2]);
    await act(async () => setValue(byLabel("Port"), "70000"));
    await click(button("Save cluster"));
    expect(client.createCluster).not.toHaveBeenCalled();
    expect(Array.from(dialog().querySelectorAll(".mm-validation li")).map((li) => li.textContent)).toEqual(["A distributed cluster needs a port from 1 to 65535."]);

    await act(async () => setValue(byLabel("Port"), "8080"));
    await click(button("Save cluster"));
    expect(client.createCluster).toHaveBeenCalledWith({
      name: "Lab pair",
      kind: "distributed",
      memberIds: ["spark1", "mac"],
      headId: "spark1",
      endpoint: { host: null, port: 8080 },
      engine: null,
      launcherId: null,
      notes: "",
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(client.listClusters).toHaveBeenCalledTimes(2);
  });

  it("accepting a suggestion pre-fills the form and saves it only on Save", async () => {
    await open();
    await click(button("Use suggestion"));
    expect(client.createCluster).not.toHaveBeenCalled();
    expect(byLabel("Name").value).toBe("spark1 cluster");
    await click(button("Save cluster"));
    expect(client.createCluster).toHaveBeenCalledWith(expect.objectContaining({ id: "spark1-cluster", memberIds: ["spark1", "spark2"], headId: "spark1" }));
  });

  it("edits with PUT and never changes the id", async () => {
    await open();
    await click(button("Edit"));
    expect(byLabel("ID").disabled).toBe(true);
    await act(async () => setValue(byLabel("Name"), "Duo v2"));
    await click(button("Save cluster"));
    expect(client.updateCluster).toHaveBeenCalledWith("duo", expect.objectContaining({ name: "Duo v2", launcherId: "vllm-ray" }));
    expect(vi.mocked(client.updateCluster).mock.calls[0][1]).not.toHaveProperty("id");
  });

  it("deletes only after confirmation", async () => {
    const { onChanged } = await open();
    await click(button("Delete"));
    expect(client.deleteCluster).not.toHaveBeenCalled();
    expect(dialog().textContent).toContain("This cannot be undone");
    await click(button("Back"));
    expect(client.deleteCluster).not.toHaveBeenCalled();
    await click(button("Delete"));
    await click(button("Delete cluster"));
    expect(client.deleteCluster).toHaveBeenCalledWith("duo");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("reports a failed delete as not deleted (not 'not saved')", async () => {
    vi.mocked(client.deleteCluster).mockRejectedValue(new client.FleetApiError("disk full", 500));
    await open();
    await click(button("Delete"));
    await click(button("Delete cluster"));
    const alert = dialog().querySelector("[role=alert]")!;
    expect(alert.textContent).toBe("The cluster was not deleted: disk full");
  });

  it("explains a 409 conflict from the server", async () => {
    vi.mocked(client.deleteCluster).mockRejectedValue(new client.FleetApiError("cluster has a running operation", 409));
    await open();
    await click(button("Delete"));
    await click(button("Delete cluster"));
    const alert = dialog().querySelector("[role=alert]")!;
    expect(alert.textContent).toContain("Another operation is already running");
    expect(alert.textContent).toContain("cluster has a running operation");
  });
});
