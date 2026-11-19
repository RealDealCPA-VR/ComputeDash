# Fleet model manager

The **Models** page (`/models`, also in the navigation rail and the command palette) manages models across every registered unit and every logical cluster from one place. For each target it shows which models are installed, configured, loaded and serving, and it can start, stop, reload and switch them. Every manual control works with smart routing turned off.

It is on by default. `fleetModelsEnabled: false` in Settings (or `PUT /api/settings`) hides the page, stops all collection for it, and makes every `/api/fleet/*` route answer `404`, except `GET /api/fleet/status` and reading or cancelling an operation that is already running.

**Control needs an access token.** Reading targets and inventories works without one, but starting, stopping, reloading or switching a model, cancelling an operation, and creating, changing or deleting a cluster are refused with `403 token_required` until `SPARKDASH_TOKEN` is set, even from a browser on the dashboard machine. The page then shows a banner and locks its controls. `npm run setup` creates the token in `.env`; restart the dashboard and enter the token when the browser asks. See [Security](#security).

Design background: [PRD](PRD-CROSS-PLATFORM-MODEL-MANAGEMENT.md) and [development plan](FLEET-MODEL-MANAGER-PLAN.md). Where they differ from this guide, this guide follows the code.

- [Targets](#targets)
- [Clusters](#clusters)
- [Model states](#model-states)
- [Engines and adapters](#engines-and-adapters)
- [Operations](#operations)
- [Logs](#logs)
- [HTTP API](#http-api)
- [Smart routing (optional)](#smart-routing-optional)
- [Security](#security)
- [Hosting on Windows (Dell Precision)](#hosting-on-windows-dell-precision)
- [Adding an engine adapter](#adding-an-engine-adapter)
- [Troubleshooting](#troubleshooting)

## Targets

A **target** is something a model can run on. There are two kinds:

| Kind | `targetId` | Comes from |
| --- | --- | --- |
| Node | `node:<unitId>` | A registered unit (Spark, GPU host, Windows PC, Mac). Nothing extra to configure. |
| Cluster | `cluster:<clusterId>` | A record in `config/fleet-clusters.json`, created on the page under **Clusters**. |

A node is identified by its registry id, which is persistent. Its address is whatever the unit already uses: `ssh.host`, `llmHost` or `lanIp`. All of these accept Tailscale IPs (`100.x.y.z`) and MagicDNS names (`spark-1.tailnet.ts.net`), so a unit keeps its identity when its address changes. There is no automatic tailnet discovery; add units as usual.

Each target shows:

- **Health**: `ready`, `degraded`, `unreachable` or `unknown`, from the unit monitor. A node is degraded when it has a critical Health finding or a detected engine that does not answer.
- **Hardware**: label and total memory. Sparks and Macs report unified memory; GPU hosts report total VRAM. Unknown memory stays unknown, never 0.
- **Serving count**: models in state `serving`, de-duplicated. It is unknown until the target's inventory has been read, and stays unknown while the target is unreachable, its inventory is stale, or one of its runtimes failed.
- **Busy**: an operation holds the target.

### Inventory and caching

A target's inventory is collected when the page asks for it and cached for 10 seconds. **Refresh inventory** forces a fresh collection. Each discovery request has a 4-second timeout, and a whole collection is abandoned after 60 seconds.

The inventory reads, in parallel:

- the engines the unit monitor detected on each LLM port (`metrics.llm[]` in the snapshot), each asked through its adapter;
- the unit's launch profiles (its registered model launchers, `start.sh` / `stop.sh`) and their process status;
- on agent-backed Macs, the Mac agent's runtime-control catalog.

An engine that listens only on the unit's loopback is reached through a temporary SSH tunnel, closed again after the collection or operation.

When a target stops answering, the inventory marks it unreachable and retries with a per-target backoff of 2 s, doubling to 60 s. An explicit refresh skips the backoff for any target. For a node, a monitor that sees the unit online also skips it; for a cluster it does not, even when the head is online. A refresh that fails outright serves the previous inventory with `stale: true`.

## Clusters

A cluster groups two or more nodes. There are two kinds, and the difference matters:

| | Distributed | Visual group |
| --- | --- | --- |
| Meaning | The members cooperate to serve one model at one endpoint (for example vLLM with tensor parallelism across two Sparks). | The nodes are only shown together. |
| Endpoint | Required: `{ host, port }`. An empty host means the head's LLM host. | None. |
| Models | One logical inference instance, listed once, under the cluster. | None of its own. Manage models on the member nodes. |
| Memory | Sum of the members' memory, when every member reports it. | Not pooled (unknown). |
| Lifecycle | Only with a launch profile (`launcherId`) on the head. | None. |

Rules the store enforces:

- Every cluster needs at least 2 members, each a registered unit, listed once. The head (`headId`) must be a member. A distributed cluster must name its head.
- A unit can belong to at most one distributed cluster. It can be in any number of groups.
- The id is a slug (lowercase letters, digits, `-`, up to 48 characters). It is made from the name when you leave it empty, and it never changes.
- The endpoint host must be a hostname, MagicDNS name, IPv4 or IPv6 address, with no scheme, port or path.
- A `launcherId` must name an existing launch profile on the head.
- At most 64 clusters.
- A cluster cannot be edited or deleted while an operation runs on it (`409`).
- When a unit is removed from the registry, it leaves its clusters. A cluster left with fewer than 2 members is removed, and so is a distributed cluster that loses its head. A group that loses its head takes its first remaining member as head.

**Head, endpoint and launch profile.** The distributed runtime is served by the head. The engine on the endpoint port is identified from the cluster's `engine` field, or from what the monitor detects on the head at that port. Start and stop go through the launch profile on the head; that profile starts and stops the whole distributed runtime. A distributed cluster without a launch profile is discover-only: its models show, but there are no lifecycle controls (`capabilities.distributedControl: false`).

**No double counting.** On a member node, the engine at the cluster endpoint and the head's cluster launch profile are not the node's own. The node lists those models under **Cluster models**, read-only, with `servedBy: "cluster:<id>"`. Fleet totals count each `(normalized endpoint, model id)` pair once. Members keep reporting their own hardware telemetry. A member's cluster-model rows come from the cluster's cached inventory; when that is older than 60 seconds, stale or unreachable, the rows show `unknown` with the last state seen.

**Suggestions.** The Clusters dialog suggests a distributed cluster for every unit with role **Head** that has **Worker** units pointing at it (`workerHeadId`), unless the head is already in a distributed cluster. The suggestion uses the head's first LLM port as the endpoint. Nothing is created until you accept it.

## Model states

Every model on a target has exactly one of ten states. Each state comes from evidence; when there is none, the state is `unknown`. The rules are applied in this order:

| State | Evidence |
| --- | --- |
| `unreachable` | The target, or the runtime that answers for this model, did not answer. Models seen before stay listed, with their previous state in `lastSeen`; they are never shown as current. |
| `starting` | A dashboard operation is starting or loading the model, or the model's launch / Mac profile process runs but the serving API does not list the model yet. |
| `stopping` | A dashboard operation is stopping or unloading the model, or a launch profile's stop script is running. |
| `failed` | The model's last operation failed (a dashboard operation, a launch-profile job or a Mac agent action), and nothing newer has been observed. A model that is listed, loaded or running after the failure moves on. |
| `serving` | The serving API lists the model and the runtime's readiness check passed. |
| `loaded` | The model is in memory (Ollama `/api/ps`, LM Studio `state: "loaded"`) or listed, but readiness is not confirmed. |
| `configured` | A launch profile or Mac profile exists and its process is stopped (or its status is not reported, with no discovery failure). |
| `stopped` | As `configured`, but the model was seen serving earlier in this dashboard session. This memory resets when the dashboard restarts. |
| `installed` | Present on disk or in the engine's catalog only (Ollama `/api/tags`, LM Studio downloaded models). |
| `unknown` | A discovery source failed, or nothing is known. |

Some consequences:

- An installed model is not loaded, and a running process is not serving.
- If Ollama's `/api/ps` fails, nobody knows which installed models are loaded, so they show `unknown`, not `installed`.
- If a single-model engine stops answering, the models the monitor last saw on it show `unknown` or `unreachable`, never `serving`.
- Failed discovery sources are listed verbatim in the inventory's `errors`.

Each model has a stable **model key**, `<engine>|<slot>|<modelId>`. The slot is a port number, `launcher:<launcherId>` or `mac:<runtime>`. A launch profile's key is `launch-profile|launcher:<id>|<id>`, so it survives a rename and a start or stop. While a profile's process serves on its port, the profile row takes over the API's row: `modelId` becomes the id the API reports and `engine` the serving engine, but the key and the control path (the profile) stay the same.

## Engines and adapters

Each engine has an adapter. Adapters call fixed URL paths and fixed command templates only. A model id must match `^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$`, contain no `..`, and be in the runtime's discovered catalog before it reaches a request body or a command.

| Engine (`engine`) | Discover | Start / stop | Load / unload | Logs | Notes |
| --- | --- | --- | --- | --- | --- |
| Ollama (`ollama`) | `GET /api/tags` (installed), `GET /api/ps` (loaded) | – | `POST /api/generate` with `keep_alive: -1` (load) or `0` (unload), no prompt | – | Multi-model. Works over HTTP alone, so also on Windows units. Memory estimate from the model size. |
| LM Studio (`lmstudio`) | `GET /api/v0/models` (`loaded` / `not-loaded`) | – | `lms load '<id>' --yes` / `lms unload '<id>'` over SSH, with `~/.lmstudio/bin` added to `PATH` | – | Multi-model. Discover-only where there is no shell on the unit, which includes Windows units. |
| vLLM (`vllm`) | `GET /v1/models`, `GET /health` | Only through a launch profile on the same port | – | Through the launch profile | Single-model. |
| llama.cpp server (`llama.cpp`) | `GET /v1/models`, `GET /health` (`503` or a non-`ok` status means still loading) | Only through a launch profile | – | Through the launch profile | Single-model. |
| SGLang (`sglang`) | `GET /v1/models`, then `GET /health` or `GET /get_model_info` | Only through a launch profile | – | Through the launch profile | Single-model. |
| macOS runtime profiles (`mac-profile`) | Mac agent `GET /control`: catalog and serving probe | Mac agent `POST /control/start` / `stop` for that catalog entry | – | Output of the agent's latest control operation | Agent-backed Macs with runtime control enabled (`SPARKDASH_MAC_CONTROL_TOKEN`, see [agents/macos/README.md](../agents/macos/README.md#runtime-control)). Start and stop follow the catalog's `startable` / `stoppable` flags. |
| Launch profiles (`launch-profile`) | The unit's model launchers, with process status | The profile's `start.sh` / `stop.sh` | – | Output of the unit's latest launcher job | Any engine. Discover-only on Windows units, where launchers cannot run. |

Other engines the monitor detects (TensorFold, ds4, EXL3 and so on) have no adapter. Their models show from the monitor's own probe, read-only, with no controls.

**Launch profiles are the lifecycle path for single-model servers.** A vLLM, llama.cpp or SGLang server that was started by hand can be watched but not stopped or switched from here. Register it as a launch profile with its port, and the profile row becomes its control point. Readiness is checked on the profile's port. A profile with no port can be started and stopped, but it is never reported as serving, and it cannot be the target of a switch or a reload (see [Operations](#operations)).

## Operations

The model table offers **Start**, **Stop**, **Reload**, **Switch** and **Logs** per model. Buttons appear only when the model's state and its runtime allow the action:

| Action | Allowed from | Needs |
| --- | --- | --- |
| Start | `installed`, `configured`, `stopped`, `failed` | start or load |
| Stop | `serving`, `loaded`, `starting`, `failed` | stop or unload |
| Reload | `serving`, `loaded`, `failed` | both |
| Switch to | `installed`, `configured`, `stopped`, `failed` | start or load |

Nothing is offered while the target is unreachable.

**Switch model** opens a dialog: pick the model to run, check the memory estimate against the target's capacity, choose **Force** and **Roll back on failure** (on by default), review the summary, then confirm. The operation panel then polls the operation every second and shows each step and its log.

### One operation per target

Only one operation runs on a target at a time. A cluster operation also locks every member node, and a node operation blocks every cluster that contains the node. A second request gets `409` at once. While a unit is locked, the dashboard's own stream sampling pauses on it.

### Steps

Each operation is a fixed list of steps. Every step is logged with a timestamp and its outcome (`done`, `failed` or `skipped`).

| Action | Steps |
| --- | --- |
| Start | reachable, available, capacity, guard, start, ready, refresh |
| Stop | reachable, available, guard, stop, refresh |
| Reload | reachable, available, guard, stop, start, ready, refresh |
| Switch | reachable, available, capacity, guard, stop-current, start, ready, refresh |

What each step does:

1. **Reachable.** Collect a fresh inventory (never the cached one, and ignoring the backoff). The target must answer. A target whose reachability cannot be confirmed fails this step too.
2. **Available.** The model must be in that fresh inventory, its state and capabilities must allow the action, and there must be a control path: a launch profile, a Mac profile, or a multi-model runtime (Ollama, LM Studio). A switch or reload to a launch profile that has no port is refused here (code `no_port`): without a port the new model's readiness cannot be verified, so the dashboard will not stop anything for it. Set a port on the profile.

   For a switch, this step also finds the **current** models: the active models on the same runtime only.
   - Ollama / LM Studio: every model loaded on the same engine and port.
   - Launch profile: anything active on the same port.
   - Mac profile: anything on the same Mac runtime or port.

   Models on other ports keep running. The operation's `fromModelKeys` lists every model the switch will stop. Each must be stoppable from the dashboard. If one is not (for example a hand-started vLLM on the same port), the switch fails here and changes nothing.
3. **Capacity** (start, switch). Compare the model's memory estimate with the target's total memory (unified memory, VRAM, or a distributed cluster's sum). It is the total, not the free memory. If either number is unknown, the step logs "unknown" and continues. If the estimate exceeds the total, the operation stops unless `force` is set.
4. **Guard.** Count the requests in flight, from the monitor snapshot, on the ports of the models that will be stopped (switch: the current models; stop and reload: the model itself). If any are running, the operation stops unless `force` is set. If the count is unknown, the step logs that and continues.
5. **Stop current / Stop.** Unload (multi-model runtimes) or stop (profiles) each model. For a launch profile, wait for the stop script to exit. Then poll fresh inventories until the model no longer holds the runtime. Timeout: 5 minutes.
6. **Start.** Load or start the requested model. A launch profile's script output is copied into the operation log, and a failed start script fails the step at once.
7. **Ready.** Poll fresh inventories, starting at 2 s and growing by 1.5× up to 15 s, until the model is `serving`: listed by the serving API with the health check passing. It fails early if the model turns `failed` or the start script fails. Timeout: 10 minutes for a node, 30 minutes for a cluster. For a plain **Start** of a launch profile with no port, the step instead watches the start script for 20 seconds, then requires a fresh status showing its process running. It reports "process running; serving not verified (no port)", and the model shows `starting`, never `serving`.
8. **Rollback** (switch only, when it fails after the current model was stopped, rollback is on, and the operation was not cancelled). Logged as its own steps: stop the requested model if it was started, start again exactly the models this switch stopped (`fromModelKeys`), and wait for them to be ready. The operation still ends as `failed`. If the rollback fails too, those models are marked `failed`. With rollback off, the previous model stays stopped and the log says so.
9. **Refresh.** Refresh the cached inventory, so the page shows what is true now. This also runs after a failure or a cancel.

A refusal in steps 1 to 4 changes nothing and marks no model `failed`. A failure is recorded only against a model the operation actually sent a stop or start for, and that model shows `failed` until newer evidence supersedes it.

**Cancel** (the panel's **Cancel**, or `DELETE /api/fleet/operations/:opId`) is honoured only while the operation waits for readiness (the **Ready** and rollback **Ready** steps). Stopping in the middle of a stop or start could leave nothing running, so at any other step the answer is `{ cancelled: false, reason }` and the operation goes on. An accepted cancel stops the waiting. It never kills an engine that has already started, and it does not roll back. Pending steps are marked skipped and the operation ends as `cancelled`, except during the rollback's **Ready** step: the switch had already failed, so the operation ends as `failed` with the rollback logged as cancelled.

**Activity events.** Each operation records `fleet.<action>.started`, then `fleet.<action>.succeeded`, `.failed` or `.cancelled` (for example `fleet.switch.succeeded`) in the Activity log, with the target, operation id and model keys. Cluster changes record `fleet.cluster.created`, `.updated` and `.removed`.

**Lifetime.** Operations live in the dashboard's memory. The last 50 finished operations stay readable, each with up to 2000 log lines. After a dashboard restart an operation id is unknown (`404`), and the panel says its outcome is unknown: check the inventory before you try again. On shutdown, running operations stop waiting; nothing on the units is killed.

## Logs

**Logs** on a model, or `GET /api/fleet/targets/:targetId/logs?modelKey=…`, returns the best source the dashboard has:

| Source | When |
| --- | --- |
| `launcher` | The model is a launch profile (or the cluster's launch profile). The output of the unit's latest launcher job, if that job belongs to this profile. Only the latest start or stop job per unit is kept. |
| `mac-agent` | The model is a Mac profile. The output of the agent's latest control operation. |
| `none` | Any other engine. Ollama, LM Studio and engines started outside the dashboard do not expose their logs to it; read them on the unit. |

The operation panel also shows each operation's own step log, which includes the launcher job output for that operation.

## HTTP API

All routes are under the dashboard's normal authentication (see [Security](#security)). Bodies and responses are JSON. Errors are `{ "error": string, "code"?: string }`, also when the request fails before a route answers: malformed JSON gives `400` with code `invalid_json`, a body over the limit `413` with code `payload_too_large`, and an unexpected error there `500 { "error": "Request failed", "code": "internal_error" }`. Errors raised inside a route use that route's own code, for example `500 { "error": "Fleet request failed", "code": "internal" }` from the fleet routes and `proxy_error` from the smart-routing proxy. While `fleetModelsEnabled` is false, every route below answers `404` with code `disabled` (`fleet_disabled` on `/api/fleet/v1/*`), except `GET /api/fleet/status` and `GET` / `DELETE /api/fleet/operations/:opId`. Control routes (marked **control**) answer `403 token_required` while no dashboard token is configured. Rate limits, per client: the fleet reads (`targets`, `inventory`, `operations`, `operations/:opId`, `logs`, `clusters`) share 240 requests per minute; cancels 60 per minute; everything under `/api/fleet/v1/*` 120 per minute. Starting an operation and changing a cluster spend the dashboard's limits for destructive actions, after the request body has been validated; a request that is then refused by the operation runner (`404`, `409`) or by the cluster store (`400`, `409`) has still spent its allowance. `GET /api/fleet/status`, `GET /api/fleet/routing` and `POST /api/fleet/routing/resolve` have no limiter. Over a limit the answer is `429`.

| Method and path | Body / query | Success | Errors |
| --- | --- | --- | --- |
| `GET /api/fleet/status` | – | `200 { enabled, smartRoutingEnabled, adapters: [{ engine, label, capabilities }], controlRequiresToken, tokenConfigured }` | – (answers even while the feature is off) |
| `GET /api/fleet/targets` | – | `200 { targets: FleetTarget[], generatedAt }` | – |
| `GET /api/fleet/targets/:targetId/inventory` | `?refresh=1` (`1`, `0`, `true`, `false`) | `200 FleetInventory` | `400` bad target id or `refresh`; `404` unknown target |
| `POST /api/fleet/targets/:targetId/operations` (**control**) | `{ action: "start"\|"stop"\|"reload"\|"switch", modelKey, force?: boolean, rollback?: boolean }`; no other fields | `202 { operation: FleetOperation }` | `400` validation; `403 token_required`; `404` unknown target, or a model the cached inventory does not list; `409` busy; `503` shutting down |
| `GET /api/fleet/operations` | `?active=1` (only running), `?active=0` or none (running plus those finished in the last 10 minutes) | `200 { operations: FleetOperation[] }`, newest first | `400 validation` (unknown query key or value) |
| `GET /api/fleet/operations/:opId` | `?since=<seq>` | `200 { operation, lines: [{ seq, text }], nextSeq }` | `400` bad id; `404` unknown operation |
| `DELETE /api/fleet/operations/:opId` (**control**) | – | `200 { cancelled: true }`, or `200 { cancelled: false, reason }` when the operation is not waiting for readiness, has finished, or a cancel was already requested | `400`; `403 token_required`; `404` |
| `GET /api/fleet/targets/:targetId/logs` | `?modelKey=` | `200 { source: "launcher"\|"mac-agent"\|"none", lines, note? }` | `400`; `404` |
| `GET /api/fleet/clusters` | – | `200 { clusters, suggestions }` | – |
| `POST /api/fleet/clusters` (**control**) | `{ id?, name, kind, memberIds, headId, endpoint, engine, launcherId, notes }` | `201 { cluster }` | `400` validation (including a launch profile missing on the head); `403 token_required`; `409` id taken, or a unit already in another distributed cluster |
| `PUT /api/fleet/clusters/:id` (**control**) | Any of the fields above; `id` is ignored | `200 { cluster }` | `400`; `403 token_required`; `404`; `409` busy or conflict |
| `DELETE /api/fleet/clusters/:id` (**control**) | – | `200 { removed: true }` | `400`; `403 token_required`; `404`; `409` busy |
| `GET /api/fleet/routing` | – | `200 { enabled, policy, table: RouteEntry[] }` (`enabled: false`, empty table while routing is off) | – |
| `POST /api/fleet/routing/resolve` | `{ model }` | `200 { target, targetId, endpoint, model, policy, load, reason }` (`target: null` when nothing serves it) | `400 invalid_body` / `invalid_model`; `401` when a token is set and not sent; `404 routing_disabled` |
| `GET /api/fleet/v1/models` | – | `200 { object: "list", data: [{ id, object: "model", owned_by: "sparkdash-fleet" }] }` | `401` (not direct local, see [Security](#security)); `403 token_required`; `404 routing_disabled`; `429` |
| `POST /api/fleet/v1/chat/completions`, `/completions`, `/embeddings` | OpenAI request body, up to 4 MB | The engine's status and body, streamed | `400`; `401`; `403 token_required`; `404 model_not_served` / `routing_disabled`; `413` body over 4 MB; `429`; `502 upstream_unreachable`; `504 upstream_timeout` |

The response types are defined in [`src/api/fleetTypes.ts`](../src/api/fleetTypes.ts). The main fields:

- `FleetTarget`: `targetId`, `kind`, `id`, `name`, `platform`, `hardware { label, memoryTotalBytes, memoryKind }`, `online`, `health`, `memberIds`, `headId`, `clusterIds`, `clusterKind`, `capabilities { distributedControl, lifecycle }`, `servingCount`, `servingModels` (model ids of the de-duplicated serving models, alphabetical; `null` exactly when `servingCount` is `null`), `busy`, `activeOperationId` (the running operation on this target, on a cluster it belongs to, or for a cluster on a member node; `null` when idle, so `busy === (activeOperationId !== null)`).
- Freshness: `servingCount` and `servingModels` come from inventories at most 90 seconds old. While anyone reads targets or inventories (the Models page, the Overview's fleet board), the server refreshes inventories in the background every 60 seconds for the next 2 minutes; polling operation records does not count. Routing keeps its own stricter 60-second rule.
- `FleetInventory`: `targetId`, `collectedAt`, `reachable`, `runtimes[]`, `models[]`, `clusterModels[]`, `errors[]`, `stale`.
- `FleetRuntime`: `engine`, `port`, `endpoint`, `reachable`, `capabilities`, `error`, `requestsRunning`, `note` (why a capability is off).
- `FleetModel`: `modelKey`, `modelId`, `label`, `engine`, `port`, `state`, `sources`, `quantization`, `contextLength`, `sizeBytes`, `estMemoryBytes`, `launcherId`, `macRuntime`, `endpoint`, `servedBy`, `actions { start, stop, reload, switchTo }`, `lastError`, `lastSeen?`.
- `FleetOperation`: `id`, `targetId`, `action`, `modelKey`, `fromModelKeys` (every model a switch stops and would restore), `fromModelKey` (the first of them), `status` (`running`, `succeeded`, `failed`, `cancelled`), `step`, `steps[{ id, label, status, detail }]`, `startedAt`, `finishedAt`, `error`.

Example: switch the Spark cluster to another model, without rollback.

```bash
curl -X POST http://127.0.0.1:5555/api/fleet/targets/cluster:spark-cluster/operations \
  -H "Authorization: Bearer $SPARKDASH_TOKEN" -H "Content-Type: application/json" \
  -d '{"action":"switch","modelKey":"launch-profile|launcher:qwen3-tp2|qwen3-tp2","rollback":false}'
```

## Smart routing (optional)

Smart routing is a separate setting, **off by default** (`smartRoutingEnabled`). It only chooses among targets that already serve the requested model. It never starts, stops, loads or switches a model. Everything else on the Models page works the same with it off.

When it is on:

- An OpenAI-compatible endpoint is available at `/api/fleet/v1` on the dashboard's own origin and port (for example `https://dell.tailnet.ts.net/api/fleet/v1`). Set it as the client's base URL and the dashboard token as the client's API key. A request to `/api/fleet/v1/*` goes through, in order: the dashboard's authentication middleware (the token is checked on every `POST`, and on a `GET` unless the request is direct local, from the dashboard machine itself); the gate (fleet on, routing on, and a dashboard token configured on the server, else `403 token_required`); a limit of 120 requests per minute per client; and the JSON body limit of 4 MB (`413` above it). Nothing is buffered before the gate has passed. So `GET /api/fleet/v1/models` answers a client on the dashboard machine without a bearer token (once a token is configured and routing is on), while a client coming through Tailscale Serve or a proxy needs it; the routed `POST` requests always need it.
- The **Routing** panel on the Models page shows the state, the policy, the route table and a resolve tester.
- Cached inventories are refreshed in the background every 30 seconds, so the route table stays fresh. This refresh does not run while routing is off.

**Which targets qualify.** A model is routable on a target only when the target's cached inventory lists it as `serving`, the inventory is less than 60 seconds old and not stale, and both the target and the runtime serving the model are reachable. Cluster models shown on member nodes are not routes of their own; the cluster is. The same endpoint and model pair is listed once, under the cluster when there is one.

**Model names.** The requested `model` must match a served model id exactly, or match exactly one served id ignoring case. The forwarded request carries the engine's exact id. There is no fuzzy or prefix matching.

**Policies** (`smartRoutingPolicy`):

| Policy | Pick |
| --- | --- |
| `least-loaded` (default) | Fewest requests running: the engine's `requestsRunning` plus the proxy's own open requests. Targets whose load is unknown come after every known load. |
| `first-available` | The first candidate by target id. |
| `round-robin` | Rotates through the candidates, per model. `resolve` does not advance the rotation. |

**The proxy.** It forwards only the JSON body to `<endpoint>/v1/<path>` on the chosen engine. Client headers, including the dashboard `Authorization` header, are never forwarded; when the unit has an API key stored for that port, the proxy sends that key instead. The response carries the engine's status code, content type and body (streamed for `stream: true`), plus `X-Sparkdash-Target` naming the target. Other engine headers are dropped. If the connection to the first candidate is refused or unroutable, the next candidate is tried; any other failure is not retried. An engine that sends no response headers within 30 seconds gets `504`.

**Only direct endpoints route.** Routes point at the engine endpoint the inventory used, and only endpoints the dashboard reached directly qualify. An engine reached through an SSH tunnel is never a route (the tunnel is a temporary local forward, closed after each collection), and neither is a loopback endpoint not verified as direct. Known limits:

- An engine reachable only through an SSH tunnel is not routable. Give the unit a direct tailnet address (`llmHost`, for example its MagicDNS name) that the engine listens on, and it becomes routable.
- A cluster whose endpoint is the dashboard host's own loopback (the dashboard running on the cluster head, with endpoint host `127.0.0.1`) is not routable. Set the endpoint host to the head's tailnet or LAN address.

## Security

- **One authentication scheme.** The fleet routes and the proxy use the dashboard's global middleware and its single token, `SPARKDASH_TOKEN`. There is no separate fleet login. The token travels as `Authorization: Bearer <token>`; `?token=` is accepted only on the WebSocket. The dashboard-wide rules are in [REMOTE-ACCESS.md](REMOTE-ACCESS.md#security-model): without a token, a browser on the dashboard machine itself (direct local) can read and change everything else, while requests through Tailscale Serve or a reverse proxy can only read. Once a token is set, every change needs it, and so do proxied reads.
- **Fleet control always needs a token.** Operations, cancel, cluster changes and the smart-routing proxy answer `403 token_required` until `SPARKDASH_TOKEN` is set, whether the request is direct local or proxied. `GET /api/fleet/status` reports `controlRequiresToken` and `tokenConfigured`. `SPARKDASH_FLEET_ALLOW_NO_TOKEN=1` turns this requirement off; it is not recommended, and only makes sense on a single-user host that nothing else can reach (no Tailscale Serve, no proxy). The server logs a warning at startup when it is set.
- **Reads.** With a token set, proxied clients need it to read targets, inventories, operation records and their logs, launcher and Mac agent output (`/api/fleet/targets/:targetId/logs`), clusters, the route table and `GET /api/fleet/v1/models`. Without a token, those reads are open to every client the front door admits, so limit who reaches the dashboard with the front door's identity policy (Tailscale ACLs or grants, or the proxy's authentication). Direct-local reads are never token-checked.
- **Loopback by default.** The server binds `127.0.0.1`. Keep it that way.
- **Publish through Tailscale Serve.** `tailscale serve --bg 5555` makes the dashboard available to your tailnet over HTTPS, with no open port (see the README's [Tailscale Serve](../README.md#tailscale-serve-https) section). Set `SPARKDASH_TOKEN` as well (`npm run setup`); fleet control stays refused until you do.
- **Never expose unauthenticated control.** A non-loopback bind without a token refuses to start (unless `SPARKDASH_ALLOW_OPEN_REMOTE=1`, which is not recommended). Do not publish the dashboard with `tailscale funnel` or a reverse proxy that does not authenticate. See [REMOTE-ACCESS.md](REMOTE-ACCESS.md).
- **What reaches the units.** Adapters call fixed URL paths and fixed command templates. Model ids are validated against a strict pattern and the discovered catalog before they reach a request body or an `lms` command, where they are single-quoted. Adapter requests refuse redirects, and their responses are capped at 2 MB. Engine API keys stay on the server.

## Hosting on Windows (Dell Precision)

The dashboard runs natively on Windows 11. These steps assume the Dell Precision is the dashboard host and all units are reachable over Tailscale.

### Requirements

- **Node.js 22.** The dependencies need Node 22 (CI uses 22.22.2). Check with `node --version`.
- **OpenSSH client.** Windows 11 ships `ssh.exe`. Check with `ssh -V`. The dashboard calls `ssh` from `PATH`.
- **SSH keys to every unit.** Password login needs `sshpass`, which Windows does not have, so give every SSH unit a key. Keys in `%USERPROFILE%\.ssh` are used as with any OpenSSH client; set `SSH_IDENTITY_FILE` for a key with another name.
- **Tailscale** installed and signed in.

### Install and run

```powershell
git clone https://github.com/RealDealCPA-VR/ComputeDash.git
cd ComputeDash
npm ci
npm run setup
npm run build
```

`npm run setup` checks Node and `ssh`, reports this machine's Tailscale name, creates `.env` (read at startup) from `.env.example`, and adds a random `SPARKDASH_TOKEN` if none is set. It never replaces an existing token and can be run again at any time; `npm run setup -- --check` only reports, and `npm run setup -- --print-token` shows the token. The token is required for fleet control (see [Security](#security)). To create one by hand instead, add `SPARKDASH_TOKEN=<value>` to `.env`, with a value from:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

SSH connection reuse (multiplexing) is off by default on Windows, since `ssh.exe` does not support it; each command opens its own connection. Nothing needs configuring. (`SSH_MULTIPLEX=0` turns reuse off on every platform, and any other non-empty value turns it on.)

Start the dashboard:

```powershell
npm start
```

Open `http://127.0.0.1:5555` on the Dell. To reach it from other devices, publish it with Tailscale Serve (from an administrator PowerShell if the command reports access denied):

```powershell
tailscale serve --bg 5555
tailscale serve status
```

The browser asks for the token the first time it needs it and remembers it (**Settings → Access token** changes it). The dashboard has no Windows service installer. To start it at logon, `npm run setup` prints a ready-made `Register-ScheduledTask` snippet for this checkout and Node install; paste it into PowerShell (nothing is registered by setup itself). The snippet sets no execution time limit, so Task Scheduler does not stop the dashboard after 72 hours.

### What is not available on a Windows host

- **The local unit.** Local collectors read Linux `/proc` and `/sys`. To monitor the Dell itself, enable its OpenSSH Server and add it as a **Windows PC** unit, like any other Windows machine. Startup checks know this: on Windows (and macOS) they skip the `/proc`, `/sys` and Docker-mount warnings, and look for SSH keys in `%USERPROFILE%\.ssh`.
- **Password SSH** (no `sshpass`).
- **Container-only features**, such as the **Restart sparkDash** button, which restarts a Docker container.

### What is not available on Windows units

This applies to any unit with platform Windows, including the Dell when it is registered as a unit:

- Launch profiles cannot run (they are bash scripts). Existing profiles show, discover-only.
- LM Studio is discover-only (no shell for `lms`).
- Ollama load and unload work, over HTTP.
- vLLM, llama.cpp and SGLang show read-only, since their lifecycle needs a launch profile.

### Running the tests

`npm test` runs on Windows: `scripts/run-node-tests.mjs` expands the test globs in Node, because `cmd.exe` does not. Many pre-existing server tests still need a POSIX shell, Unix sockets or POSIX file modes, so a full run fails on native Windows. For the full suite:

- push to `main` or a `feature/**` branch, or open a pull request against `main`: `.github/workflows/test.yml` runs `npm ci`, `npm run typecheck`, `npm run build` and `npm test` on Ubuntu 24.04 with Node 22; or
- run `npm test` in WSL or a Linux container.

The fleet suites run on Windows directly:

```powershell
node scripts/run-node-tests.mjs server/fleet/__tests__/*.test.js
npx vitest run src/components/ModelsPage
```

The runner accepts `*` only in the last path segment, and a pattern that matches no file is an error (exit code 2), so a typo cannot silently skip a suite.

## Adding an engine adapter

An engine is one adapter object and one registration. Inventory, operations, targets and routes look adapters up by engine name and need no change.

1. The engine name must be the `backend` name the LLM probe reports for that port (`server/collectors/LlmProbe.js`), or the `engine` set on a distributed cluster. Names are short, lowercase: `^[a-z0-9][a-z0-9._-]{0,31}$`.
2. Write the adapter in `server/fleet/adapters/`. `discover(ctx)` is required. Declare `capabilities`; anything not set is `false`. Make every network call with `fetchJson` and `ctx.baseUrl`, so timeouts, size caps and test fakes apply.
3. Register it in `server/fleet/adapters/index.js`.

A minimal discover-only adapter for an OpenAI-compatible engine:

```js
// server/fleet/adapters/myengine.js
import { createOpenAiCompatAdapter } from "./openaiCompat.js";

export const myEngineAdapter = createOpenAiCompatAdapter({
  engine: "myengine",
  label: "My engine",
  healthPaths: ["/health"], // tried in order; 404 / 405 moves to the next
});
```

```js
// server/fleet/adapters/index.js
import { myEngineAdapter } from "./myengine.js";
// ...
for (const a of [ollamaAdapter, /* ... */, launchProfileAdapter, myEngineAdapter]) {
  registerAdapter(a);
}
```

Its lifecycle then comes from launch profiles on the same port, like vLLM.

For an engine that loads and unloads models itself, set `multiModel`, `load` and `unload` in `capabilities` and implement `load(ctx, modelId)` / `unload(ctx, modelId)`. Call `checkModelId(modelId, ctx.catalog)` first, and return `{ ok: true, detail? }` or `{ ok: false, error }`. `discover` returns `{ reachable, ready, models, errors, loadedKnown? }`; each model sets only the evidence it has (`installed`, `loaded`, `listed`, `ready`, ...) and its `sources`. See `ollama.js` for a complete example, and `base.js` for the contract. If the capabilities depend on the unit, add `capabilitiesFor(ctx)`, as `lmstudio.js` does for units without a shell.

Add tests under `server/fleet/__tests__/` with a fake `fetchImpl`; adapters never need the network in tests.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| The Models page is missing; `/api/fleet/*` answers `404` with code `disabled` | `fleetModelsEnabled` is false. Turn it back on in Settings. |
| A model shows `unknown` | A discovery source failed. The inventory's error list says which, verbatim. Fix the source and press **Refresh inventory**. For Ollama, `/api/ps` failing makes every installed model unknown. |
| A target is `unreachable`, and refresh says "next attempt in N s" | The target is in backoff after failed collections. **Refresh inventory** skips the backoff (a node also leaves it as soon as its monitor sees it online; a cluster waits for the backoff or a refresh). Check that the unit is online and that its `ssh.host` / `llmHost` resolves over Tailscale from the dashboard host. |
| No **Start** / **Switch** button on a vLLM, llama.cpp or SGLang model | These engines have no lifecycle API. Register a launch profile for that port. |
| LM Studio has no load / unload | Windows units have no shell for `lms`, so load and unload are off there, and the runtime's note says so. On other units the buttons show; if the unit has no working SSH login, the action fails when it runs, with the SSH error in the operation log. |
| A distributed cluster has no controls | It has no launch profile on the head. Edit the cluster and set one. |
| Switch fails at **Available** with "cannot be stopped from the dashboard" | Something the dashboard cannot stop holds the runtime, such as a hand-started server on the same port. Stop it on the unit, or register it as a launch profile. |
| Switch stops at **Capacity** or **Guard** | The estimate exceeds the target's memory, or requests are in flight. Retry with **Force** if you accept the risk. |
| **Ready** times out | The engine did not list the model with a passing health check within 10 minutes (30 for a cluster). Open **Logs**; for a launch profile, its job output is in the operation log too. |
| The operation panel says the outcome is unknown | The dashboard restarted, or the operation was pruned. Refresh the inventory to see the real state. |
| `409` on an operation | Another operation runs on this target, a cluster containing it, or one of its members. Wait for it to finish. |
| `403 token_required` on Start / Stop / Switch, cancel, cluster changes or `/api/fleet/v1` | No dashboard token is configured. Run `npm run setup` (or set `SPARKDASH_TOKEN` in `.env`) and restart. (`SPARKDASH_FLEET_ALLOW_NO_TOKEN=1` is only for single-user, loopback-only hosts, and not recommended.) |
| `401` from fleet routes or `/api/fleet/v1` | `SPARKDASH_TOKEN` is set and a `POST` / `PUT` / `DELETE` (or any request through Tailscale Serve, a proxy or a non-loopback bind) has no valid `Authorization: Bearer` header. Use the token as the OpenAI client's API key. |
| `400 invalid_json` or `413 payload_too_large` | The request body is not valid JSON, or is larger than the limit: 4 MB on `/api/fleet/v1/*`, 100 kB on the other routes. |
| Cancel answers `cancelled: false` | Cancel is honoured only while the operation waits for readiness. Wait for the current stop or start to finish, then cancel again, or let it run. |
| Switch or reload refused with `no_port` | The target is a launch profile without a port, so readiness cannot be verified. Set the profile's port. |
| Routed requests get `404 model_not_served` | No fresh inventory lists the model as `serving`. Check the Routing panel's route table; the model must be serving and its inventory under 60 seconds old. |
| A serving model is missing from the route table | Its endpoint is an SSH tunnel or an unverified loopback address. Give the unit a direct tailnet `llmHost` the engine listens on; for a cluster on the dashboard host, set its endpoint host to the head's tailnet address. |
| Routed requests get `502` | The engine endpoint stopped answering from the dashboard host. Check the engine and the network path. |
| Windows: a unit with a password fails with "sshpass is not installed" | Use key login for that unit. |
| Windows: many server tests fail under `npm test` | Expected: they need a POSIX shell. Use the Linux CI workflow, WSL or a container for the full suite. |
