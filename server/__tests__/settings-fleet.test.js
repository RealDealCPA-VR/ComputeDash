import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-fleet-settings-"));
process.env.SETTINGS_JSON_PATH = path.join(root, "settings.json");

const { updateSettings, loadSettings } = await import("../settings.js");

test("fleetModelsEnabled defaults on and smartRoutingEnabled defaults off", () => {
  const s = loadSettings();
  assert.equal(s.fleetModelsEnabled, true);
  assert.equal(s.smartRoutingEnabled, false);
});

test("fleetModelsEnabled turns off only on an explicit false", () => {
  assert.equal(updateSettings({ fleetModelsEnabled: false }).fleetModelsEnabled, false);
  assert.equal(JSON.parse(fs.readFileSync(process.env.SETTINGS_JSON_PATH, "utf-8")).fleetModelsEnabled, false);
  assert.equal(updateSettings({ fleetModelsEnabled: "no" }).fleetModelsEnabled, true);
  assert.equal(updateSettings({ fleetModelsEnabled: null }).fleetModelsEnabled, true);
  assert.equal(updateSettings({ fleetModelsEnabled: false }).fleetModelsEnabled, false);
  assert.equal(updateSettings({ fleetModelsEnabled: true }).fleetModelsEnabled, true);
});

test("smartRoutingEnabled turns on only on an explicit true", () => {
  assert.equal(updateSettings({ smartRoutingEnabled: "yes" }).smartRoutingEnabled, false);
  assert.equal(updateSettings({ smartRoutingEnabled: 1 }).smartRoutingEnabled, false);
  assert.equal(updateSettings({ smartRoutingEnabled: true }).smartRoutingEnabled, true);
  assert.equal(JSON.parse(fs.readFileSync(process.env.SETTINGS_JSON_PATH, "utf-8")).smartRoutingEnabled, true);
  assert.equal(updateSettings({ smartRoutingEnabled: false }).smartRoutingEnabled, false);
});

test("a settings file written by an older build gets the fleet defaults", () => {
  fs.writeFileSync(process.env.SETTINGS_JSON_PATH, JSON.stringify({ pollIntervalMs: 2000 }));
  const s = loadSettings();
  assert.equal(s.fleetModelsEnabled, true);
  assert.equal(s.smartRoutingEnabled, false);
});

test("smartRoutingPolicy defaults to least-loaded and only accepts known policies", async () => {
  const { SMART_ROUTING_POLICIES } = await import("../settings.js");
  const { ROUTING_POLICIES } = await import("../fleet/routing.js");
  assert.deepEqual([...SMART_ROUTING_POLICIES].sort(), [...ROUTING_POLICIES].sort());
  assert.equal(loadSettings().smartRoutingPolicy, "least-loaded");
  assert.equal(updateSettings({ smartRoutingPolicy: "round-robin" }).smartRoutingPolicy, "round-robin");
  assert.equal(JSON.parse(fs.readFileSync(process.env.SETTINGS_JSON_PATH, "utf-8")).smartRoutingPolicy, "round-robin");
  assert.equal(updateSettings({ smartRoutingPolicy: "fastest" }).smartRoutingPolicy, "least-loaded");
  assert.equal(updateSettings({ smartRoutingPolicy: 3 }).smartRoutingPolicy, "least-loaded");
});
