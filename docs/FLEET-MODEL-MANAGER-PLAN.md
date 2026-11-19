# Fleet Model Manager — development plan

Source: [PRD-CROSS-PLATFORM-MODEL-MANAGEMENT.md](PRD-CROSS-PLATFORM-MODEL-MANAGEMENT.md).
The PRD file ends partway through §3.3 (step 1 of the switch workflow). Where it stops, this plan
fills the gap with the PRD's own rules: manual control first, never fabricate state, authenticated
control, and nothing that depends on smart routing. Those additions are marked **(plan)**.

## 1. Goals and non-goals

**P0: Unified model management.** Manage models across Spark 1, Spark 2, the Spark cluster, the Dell
Precision (RTX 6000 Ada, which hosts the dashboard and may run Windows) and the Mac Studio, all from one page:

- Inventory of nodes and logical clusters, with health.
- Per-target model discovery with accurate states.
- Start / Stop / Switch / Reload / View Logs / Refresh, with a step-by-step operation log.
- Every control works with smart routing switched off.

**P1: Optional smart routing.** A separate setting, off by default. When it is on, the dashboard can
recommend and proxy an OpenAI-compatible request to a target that is already serving the requested model.
It never starts, stops or switches models by itself.

**Non-goals (first release):** automatic tailnet discovery (nodes are registered by hand, as the PRD
allows) and automatic scheduling.

## 2. Existing pieces we extend (not duplicate)

| Need | Existing code | How we use it |
|---|---|---|
| Node registry, persistent ids | `server/sparks/SparkRegistry.js` (`id`, `kind`, `platform`, `role` head/worker, `workerHeadId`, `llmHost`, `llmPorts`) | Nodes = registry units. Clusters reference unit ids. |
| Engine detection per port | `server/collectors/LlmProbe.js` via `SparkMonitor.snapshot().metrics.llm[]` (`backend`, `models[]`, `available`, `requestsRunning`, `contextLength`, `via`) | Serving evidence and engine identity |
| HTTP reach (direct, then SSH tunnel) | `server/collectors/llmTunnel.js` `resolveLlmHttpTarget`, `server/collectors/llmHost.js` | Adapter HTTP calls |
| SSH exec | `server/collectors/ssh.js` `sshExec` | Fixed CLI templates (e.g. `lms`) |
| Custom launch profiles + logs | `server/llmlaunch/` (`LauncherStore`, `LauncherManager.startJob/readJob/statuses`) | `launch-profile` adapter: configured models + start/stop + logs |
| macOS / MLX profiles | `server/collectors/MacRuntimeControl.js`, `MacAgentCollector.collectRuntimes` | `mac-profile` adapter |
| Installed models | `server/models/discovery.js`, `metrics.residentModels` | Installed evidence |
| Auth | `app.use(createAuthMiddleware())`: bearer token on every mutating request and every remote `/api` GET | Unchanged. Mutating fleet routes add rate limiters. |
| Settings flags | `server/settings.js` DEFAULTS + `_clampSettings` | `fleetModelsEnabled` (default **true**) and `smartRoutingEnabled` (default **false**) |

## 3. Architecture (new module `server/fleet/`)

```
server/fleet/
  modelStates.js      state enum + deriveModelState(evidence) (pure)
  clusterStore.js     ClusterStore → config/fleet-clusters.json (validated against the registry)
  targets.js          buildTargets(registry units, clusters, snapshots) → nodes + clusters (pure)
  adapters/
    index.js          adapter registry: registerAdapter(), getAdapter(engine), listAdapters()
    base.js           adapter contract + capability helpers + bounded fetchJson()
    ollama.js         /api/tags (installed), /api/ps (loaded), load/unload via keep_alive
    lmstudio.js       /api/v0/models (state loaded|not-loaded), load/unload via fixed `lms` CLI template over SSH
    openaiCompat.js   vllm, llama.cpp, sglang: /v1/models + health; lifecycle only through a launch profile
    macProfile.js     MacRuntimeControl targets/models; start/stop through beginRuntimeControl
    launchProfile.js  LauncherStore / LauncherManager start.sh/stop.sh profiles
  inventory.js        collectInventory(target, deps): merges evidence from all adapters, dedupes cluster models
  operations.js       OperationRunner: one operation per target, step log, readiness wait, timeouts
  FleetModelManager.js façade used by routes (targets, inventory cache, operations)
  routes.js           registerFleetRoutes(app, deps)
  routing.js          (P1) pickTarget(model, inventories, policy) (pure) + proxy handler
  routingRoutes.js    (P1) registerFleetRoutingRoutes(app, deps)
  __tests__/          node:test suites, isolated temp config
```

### 3.1 Model states (PRD §3.2)

`installed`, `configured`, `starting`, `loaded`, `serving`, `stopping`, `stopped`, `failed`, `unknown`, `unreachable`.

`deriveModelState(evidence)` precedence:

1. The target or runtime is unreachable → `unreachable`. The last known facts are kept separately as `lastSeen`; they are never shown as current.
2. An operation is in flight for this model → `starting` / `stopping`.
3. The model's last operation failed and nothing newer is known → `failed`.
4. The serving API lists the model AND the readiness check passed → `serving`.
5. Loaded in memory (e.g. Ollama `/api/ps`, LM Studio `state: loaded`) but readiness not confirmed → `loaded`.
6. A launch profile's process is running but the API does not list the model yet → `starting`. A running process is not proof of serving.
7. A launch profile / mac profile exists and its process is known to be stopped → `stopped` if it served earlier in this session, otherwise `configured`.
8. Present on disk / in the engine catalog only → `installed`.
9. The discovery source failed → `unknown`. Never a guess.

### 3.2 Targets and clusters (PRD §3.1)

- **Node** = a registry unit. `targetId = "node:<unitId>"`. Its identity is the persistent registry id, never an IP.
- **Cluster** = a `ClusterStore` record. `targetId = "cluster:<clusterId>"`.

```ts
interface FleetCluster {
  id: string;              // slug, persistent
  name: string;
  kind: "distributed" | "group";   // group = visual grouping only: no inference instance
  memberIds: string[];     // registry unit ids, ≥ 2, unique
  headId: string;          // ∈ memberIds; coordinator
  endpoint: { host: string | null; port: number } | null; // required for distributed; host null → head's llm host
  engine: string | null;   // e.g. "vllm"
  launcherId: string | null; // launch profile on the head that starts/stops the distributed runtime
  notes: string;
}
```

- A unit may belong to at most one `distributed` cluster.
- A cluster's capabilities are computed: `distributedControl = kind === "distributed" && launcherId != null`.
- **No double counting.** A model served at the cluster endpoint appears once, under the cluster. Member nodes show it as `servedBy: "cluster:<id>"` in a separate `clusterModels` list, not as their own models. Fleet totals count unique `(endpoint, modelId)` pairs. Members keep reporting their own hardware telemetry.
- Seeding **(plan)**: units that already have `role: head` with workers pointing at them (`workerHeadId`) are offered as a suggested distributed cluster in the UI. Nothing is created automatically.

### 3.3 Lifecycle operations (PRD §3.3)

Actions: `start`, `stop`, `reload`, `switch`, `refresh` (inventory), `logs`.

**Switch workflow.** Steps after 1 are **(plan)**. Every step is logged with a timestamp and outcome:

1. Confirm the target node or cluster is reachable (a fresh inventory, not the cached one).
2. Confirm the requested model is available on the target (installed / configured) and that its adapter supports the needed actions. Otherwise fail with a clear reason and change nothing.
3. Check capacity: the estimated memory requirement (when known) against the target's total memory. Unknown is reported as unknown. If the estimate exceeds capacity, require `force: true`.
4. Refuse when another operation is running on the target, or when the current model has in-flight requests (`requestsRunning > 0`), unless `force: true`.
5. Stop / unload the model currently serving on the same runtime. A single-model runtime (vLLM / llama.cpp / launch profile / mac profile) is stopped. On multi-model runtimes (Ollama / LM Studio) the current model is unloaded.
6. Start / load the requested model.
7. Wait for readiness: the model is listed by the serving API and the health check passes, polled with backoff until `readinessTimeoutMs` (default 10 min; 30 min for clusters).
8. On failure: mark it `failed`, keep the logs, and if `rollback: true` (the default) try to restore the previous model, logging that as its own steps.
9. Refresh the inventory and record an activity event (`fleet.switch.succeeded` / `fleet.switch.failed`).

`reload` = stop + start of the same model with a readiness wait. `start` / `stop` are single steps with a readiness / stopped wait.
Only one operation runs per target at a time. Cluster operations also lock every member node.

### 3.4 Networking and security (PRD §2)

- Nodes are addressed by `ssh.host` / `llmHost` / `lanIp`, all of which accept Tailscale IPs or MagicDNS names. Identity is the registry id.
- Reconnect: inventory collection degrades to `unreachable` and retries on the next refresh, with exponential backoff per target (2 s → 60 s). An operation never runs on a target last seen as unreachable unless step 1 succeeds.
- All control goes through the existing authenticated API (bearer token required for every mutating request and for remote reads). Adapters only call fixed URL paths and fixed CLI templates. A model id is validated against `MODEL_ID_RE` (`^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$`, no `..`) and against the target's discovered catalog before it reaches any HTTP body or CLI argument. It is never interpolated into a shell string unquoted.
- The P1 proxy is mounted under `/api/fleet/v1/*`, so the same auth middleware covers it. No new listener, no new port.

### 3.5 Native Windows hosting (Dell Precision)

- `npm test` currently fails on Windows: `cmd.exe` does not expand the `*.test.js` globs in `test:server`. Fix this with `scripts/run-node-tests.mjs`, which expands the globs in Node (no new dependency) and runs `node --test` with the expanded list.
- Fleet code must not assume a POSIX shell on the dashboard host. SSH comes from `ssh.exe`, which Windows 11 ships. Paths use `path.join`.
- Document Windows hosting in `docs/FLEET-MODELS.md` (Tailscale Serve, token, `npm start`).

## 4. HTTP API contract

All responses are JSON. Error responses are `{ error: string, code?: string }`. While `fleetModelsEnabled` is false, every `/api/fleet/*` route answers 404, except `GET /api/fleet/status`.

| Method & path | Body / query | Response |
|---|---|---|
| `GET /api/fleet/status` | – | `{ enabled: boolean, smartRoutingEnabled: boolean, adapters: AdapterInfo[] }` |
| `GET /api/fleet/targets` | – | `{ targets: FleetTarget[], generatedAt: number }` |
| `GET /api/fleet/targets/:targetId/inventory` | `?refresh=1` | `FleetInventory` |
| `POST /api/fleet/targets/:targetId/operations` | `{ action: "start"\|"stop"\|"reload"\|"switch", modelKey: string, force?: boolean, rollback?: boolean }` | `202 { operation: FleetOperation }`; `409` busy; `400` validation; `404` unknown target / model |
| `GET /api/fleet/operations` | `?active=1` | `{ operations: FleetOperation[] }` newest first (added after the first build) |
| `GET /api/fleet/operations/:opId` | `?since=<seq>` | `{ operation: FleetOperation, lines: {seq,text}[], nextSeq: number }` |
| `DELETE /api/fleet/operations/:opId` | – | `{ cancelled: boolean }` (cancels the readiness wait; never kills a half-started engine) |
| `GET /api/fleet/targets/:targetId/logs` | `?modelKey=` | `{ source: "launcher"\|"mac-agent"\|"none", lines: {seq,text}[], note?: string }` |
| `GET /api/fleet/clusters` | – | `{ clusters: FleetCluster[], suggestions: FleetCluster[] }` |
| `POST /api/fleet/clusters` | `FleetCluster` minus `id` (+ optional `id`) | `201 { cluster }` |
| `PUT /api/fleet/clusters/:id` | partial | `{ cluster }` |
| `DELETE /api/fleet/clusters/:id` | – | `{ removed: true }` |
| `GET /api/fleet/routing` (P1) | – | `{ enabled, policy, table: RouteEntry[] }` |
| `POST /api/fleet/routing/resolve` (P1) | `{ model: string }` | `{ target: FleetTarget \| null, endpoint, reason }` |
| `POST /api/fleet/v1/chat/completions`, `/completions`, `/embeddings`; `GET /api/fleet/v1/models` (P1) | OpenAI body | proxied response (streaming passthrough); 404 while routing is disabled |

```ts
type ModelState = "installed"|"configured"|"starting"|"loaded"|"serving"|"stopping"|"stopped"|"failed"|"unknown"|"unreachable";
type TargetKind = "node" | "cluster";
type TargetHealth = "ready" | "degraded" | "unreachable" | "unknown";

interface AdapterInfo { engine: string; label: string; capabilities: AdapterCapabilities }
interface AdapterCapabilities { discover: boolean; start: boolean; stop: boolean; load: boolean; unload: boolean; logs: boolean; multiModel: boolean }

interface FleetTarget {
  targetId: string;            // "node:<unitId>" | "cluster:<clusterId>"
  kind: TargetKind;
  id: string;                  // unit id or cluster id
  name: string;
  platform: "linux"|"darwin"|"windows"|null;
  hardware: { label: string|null; memoryTotalBytes: number|null; memoryKind: "unified"|"vram"|null } ;
  online: boolean|null;        // null = not yet known
  health: TargetHealth;
  memberIds: string[];         // clusters only ([] for nodes)
  headId: string|null;
  clusterIds: string[];        // nodes: clusters this unit belongs to
  clusterKind: "distributed"|"group"|null;
  capabilities: { distributedControl: boolean; lifecycle: boolean };
  servingCount: number|null;   // de-duplicated, null = unknown
  servingModels: string[]|null; // added later: serving model ids, null iff servingCount null
  activeOperationId: string|null; // added later: running operation on this target (or related node/cluster)
  busy: boolean;               // operation in flight
}

interface FleetRuntime { engine: string; port: number|null; endpoint: string|null; reachable: boolean|null; capabilities: AdapterCapabilities; error: string|null }

interface FleetModel {
  modelKey: string;            // stable: "<engine>|<port|profile>|<modelId>"
  modelId: string;
  label: string;
  engine: string;
  port: number|null;
  state: ModelState;
  sources: string[];           // evidence: "api", "ps", "catalog", "launcher", "mac-profile", "disk"
  quantization: string|null;
  contextLength: number|null;
  sizeBytes: number|null;
  estMemoryBytes: number|null;
  launcherId: string|null;
  macRuntime: string|null;
  servedBy: string|null;       // cluster targetId when a member node shows a cluster model
  actions: { start: boolean; stop: boolean; reload: boolean; switchTo: boolean };
  lastError: string|null;
}

interface FleetInventory {
  targetId: string;
  collectedAt: number;
  reachable: boolean|null;
  runtimes: FleetRuntime[];
  models: FleetModel[];        // owned by this target
  clusterModels: FleetModel[]; // nodes only: served by a cluster this node belongs to (never counted twice)
  errors: string[];            // per-source discovery failures, verbatim
  stale: boolean;              // true when served from cache after a failed refresh
}

interface FleetOperation {
  id: string;
  targetId: string;
  action: "start"|"stop"|"reload"|"switch";
  modelKey: string;
  fromModelKey: string|null;
  status: "running"|"succeeded"|"failed"|"cancelled";
  step: string;                // current step id
  steps: { id: string; label: string; status: "pending"|"running"|"done"|"failed"|"skipped"; detail: string|null }[];
  startedAt: number;
  finishedAt: number|null;
  error: string|null;
}

interface RouteEntry { model: string; targets: { targetId: string; endpoint: string; load: number|null }[] }
```

## 5. Frontend

- A new page `MODELS_ID = "__models__"` at `/models`. It shows when `settings.fleetModelsEnabled !== false`. Rail item, mobile tab and command palette entry follow the API Keys page pattern.
- `src/api/fleetTypes.ts` (the contract above) and `src/api/fleetClient.ts` (standalone `apiFetch`, as `apiKeysClient.ts` does).
- `src/components/ModelsPage/`:
  - `ModelsPage.tsx`: target list on the left (nodes, then clusters, with health tags), selected target detail on the right.
  - `TargetModels.tsx`: runtimes strip + model table (state `Tag`, engine, quant, context, memory estimate, actions). Member nodes show "Served by cluster X" rows read-only.
  - `SwitchModelDialog.tsx`: pick a model from the target's catalog, show the current model and memory estimate vs capacity, plus the force and rollback options. Confirm.
  - `OperationPanel.tsx`: live step list + log lines, polled every 1 s until finished, with cancel.
  - `LogsDialog.tsx`: reuses `ui/ModelOutput` / `TerminalModal`.
  - `ClusterDialog.tsx`: create / edit / delete clusters, accept suggestions.
  - `RoutingPanel.tsx` (P1): enabled state, policy, route table, resolve tester.
  - `modelStateTone.ts`: maps states to `Tag` tones and i18n keys with a `switch` (literal keys only).
- `src/styles/models.css` with the `mm-` prefix.
- i18n namespace `models`, in both `en` and `zh-CN`. Nav label in `shell.json`. Settings toggles `toggles.fleetModels` and `toggles.smartRouting`.
- Tests: page render with mocked client, state tone mapping, switch dialog validation, operation polling stop, i18n `zh-CN` smoke test, and the constants test case.

## 6. Delivery plan: teams (doer + reviewer)

Each team has a **doer** agent that implements and a **reviewer** agent that reviews independently against
this plan, the PRD and AGENTS.md. The doer fixes every confirmed finding. A team is done when the reviewer
has no blocking findings and its tests pass. Teams in the same wave own disjoint files.

| Wave | Team | Owns | Depends on |
|---|---|---|---|
| 1 | **A: Fleet core** | `server/fleet/{modelStates,clusterStore,targets,inventory}.js`, `server/fleet/adapters/*`, their tests | plan |
| 1 | **W: Windows hosting & test runner** | `scripts/run-node-tests.mjs`, `package.json` scripts (adds `server/fleet/__tests__/*.test.js`), its test | plan |
| 1 | **C: Frontend page** | `src/api/fleet*.ts`, `src/components/ModelsPage/*`, `src/styles/models.css`, `src/locales/*/models.json`, `src/i18n/index.ts`, `src/constants.ts`, shell nav files, `App.tsx` | API contract (§4) |
| 2 | **B: Operations, routes & wiring** | `server/fleet/{operations,FleetModelManager,routes}.js`, `server/index.js`, `server/settings.js`, settings tests | A |
| 2 | **R: Smart routing (P1)** | `server/fleet/{routing,routingRoutes}.js` + tests | A |
| 3 | **I: Integration UI** | `SettingsDialog.tsx` toggles, `RoutingPanel.tsx`, `src/locales/*/settings.json`, wiring R into `index.js` | B, R, C |
| 3 | **D: Docs** | `docs/FLEET-MODELS.md`, `CODEBASE.md`, `README.md` section, `CHANGELOG.md` | B, R, C |

**Done means:** `npm run typecheck`, `npm run build`, `npm test` (via the new Windows-safe runner) pass,
the final review finds nothing blocking, and the branch `feature/fleet-model-manager` is pushed to
`RealDealCPA-VR/ComputeDash` with a pull request against `main`.

## 7. Acceptance checklist (from the PRD)

Status at the end of the build (branch `feature/fleet-model-manager`). Checked items are covered by automated
tests. Nothing has been exercised against the real Sparks, Dell or Mac Studio yet.

- [x] Every connected node and logical cluster is listed, with health. (targets.js, Models page)
- [x] Installed / configured / loaded / serving models are discovered per target, with all ten states and no fabricated state. (modelStates.js, inventory.js)
- [x] Start, Stop, Switch, Reload, View Logs, Refresh Inventory work per target. (operations.js, routes.js, Models page)
- [x] The operator chooses the node or cluster that runs a model.
- [x] Hardware utilization and model execution status are visible (existing telemetry + inventory).
- [x] Smart routing is a separate toggle, off by default, and manual control works with it off.
- [x] Cluster models are counted once. A real distributed cluster is distinguished from a visual group.
- [x] Adapters cover Ollama, LM Studio, vLLM, llama.cpp, MLX / mac profiles and custom profiles. SGLang plugs in without core changes.
- [x] Nodes are identified by persistent id. Reconnect after Tailscale or host interruptions works (per-target backoff). Control is authenticated only.
- [x] The dashboard starts on native Windows: no /tmp dependency at load, and no SSH connection reuse by default. `npm test` runs there through the glob-expanding runner. Many pre-existing server tests need a POSIX shell, Unix sockets or POSIX file modes, so the full suite is verified on Linux by `.github/workflows/test.yml`.

## 8. Decisions made during the build

These came out of the reviewer rounds and refine the plan above:

- **Control requires a dashboard token.** Fleet control routes (operations, cancel, cluster changes) and the `/api/fleet/v1` proxy answer 403 `token_required` when `SPARKDASH_TOKEN` is unset, because behind Tailscale Serve every tailnet device arrives via loopback. `SPARKDASH_FLEET_ALLOW_NO_TOKEN=1` opts out on a single-user, loopback-only host. On a loopback bind, reads are not token-checked (existing dashboard behavior); see docs/REMOTE-ACCESS.md.
- **Switch scope.** "Stop current" stops only models on the same runtime (same port, Mac runtime, or engine and port). `fromModelKeys` lists everything stopped, and rollback restores exactly those.
- **Honest failures.** A model is marked `failed` only if the operation actually acted on it. A launch profile without a port cannot be switched to (`no_port`), and a plain start of one never claims `serving`.
- **Cancel** is honored only while waiting for readiness. At other times it answers `{cancelled:false, reason}`.
- **Routing** only uses endpoints reached directly. SSH-tunnel and unverified loopback endpoints are never routed. The proxy authenticates, gates and rate-limits before parsing a body (4 MB limit). Errors under `/api/fleet` are JSON.
- **Node 22** is required by the repo's dependencies.
