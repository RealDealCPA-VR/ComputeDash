# PRD: Cross-Platform Model Management for sparkDash

**Project:** sparkDash Fork – Fleet Model Manager  
**Priority:** Manual Model Management (P0), Optional Smart Routing (P1)  
**Deployment:** Local workstation with remote nodes connected through Tailscale  
**Primary Goal:** Centrally manage, load, unload, and switch AI models across independent compute nodes and multi-node inference clusters.

## 1. Product Objective

Extend the existing sparkDash application into a cross-platform AI model management dashboard.

The application must allow the operator to manage models running across multiple computers from one browser interface.

The primary purpose is **manual control of model availability and execution**, not automatic scheduling or routing.

Users must be able to:

1. See every connected compute node and logical cluster.
2. Discover installed, configured, loaded, and actively serving models.
3. Start, stop, unload, reload, and switch models.
4. Choose which node or cluster runs a particular model.
5. Monitor hardware utilization and model execution status.
6. Optionally enable intelligent model routing through a separate feature toggle.

**Critical:** All manual model-management capabilities must work with smart routing completely disabled.

## 2. Target Hardware and Network

The initial deployment consists of:

| Compute Target | Hardware | Configuration |
|---|---|---|
| Spark Node 1 | NVIDIA DGX Spark, GB10, 128 GB unified memory | Linux |
| Spark Node 2 | NVIDIA DGX Spark, GB10, 128 GB unified memory | Linux |
| Spark Cluster | Spark 1 + Spark 2 | Optional logical distributed inference target |
| Dell Precision | NVIDIA RTX 6000 Ada, 48 GB VRAM | Workstation, Windows or Linux |
| Mac Studio | Apple Silicon, 512 GB unified memory | macOS |

The Dell Precision will initially host the central sparkDash dashboard and control service. The implementation must support native Windows hosting if Windows is the workstation OS.

Every machine is connected through an existing Tailscale network.

### Networking Requirements

- Connect to nodes using their assigned Tailscale IP addresses or MagicDNS hostnames.
- Reuse existing SSH and agent-based transports wherever appropriate.
- Do not require public IP addresses, port forwarding, or cloud services.
- Identify nodes by persistent IDs, not temporary IP addresses.
- Support reconnecting after Tailscale interruptions or host restarts.
- Node control must use authenticated connections, even inside the tailnet.
- Prefer binding services to loopback with Tailscale Serve or a restricted tailnet interface.
- Never expose unauthenticated control endpoints to the general LAN or internet.

Discovery may begin with manually registered nodes; automatic tailnet discovery is not required for the first release.

## 3. Phase 1: Unified Model Management (P0)

### 3.1 Node and Cluster Inventory

Extend sparkDash's existing unit registry rather than creating a parallel system.

Support two execution-target types:

**Individual Node:** A computer capable of independently hosting inference workloads.

**Logical Cluster:** Multiple physical nodes cooperating to serve one distributed model.

A cluster must have:

- Unique cluster ID and descriptive name.
- Member nodes.
- Designated coordinator/head node.
- Inference endpoint.
- Runtime configuration.
- Cluster health and readiness state.
- Explicit capability information indicating whether distributed model control is supported.

A node may belong to a cluster while still reporting its own hardware telemetry.

However, models served by the cluster must appear as one logical inference instance, not separate model instances on every participating Spark.

Do not double-count cluster memory, tokens, or active model instances.

Cluster support must distinguish a real distributed inference deployment from two independent Sparks grouped visually.

### 3.2 Model Discovery and Registry

For each node and cluster, identify:

- Available inference runtimes.
- Configured model profiles.
- Installed or cached model files when discoverable.
- Currently loaded models.
- Actively serving models.
- Model identifiers exposed by inference APIs.
- Model quantization, context length, and estimated memory requirements when known.
- Active ports and inference endpoints.
- Runtime ownership and management capabilities.

Supported initial inference engines:

- Ollama
- LM Studio
- vLLM
- llama.cpp-based servers
- Existing macOS model profiles and compatible MLX-based runtimes
- Custom, explicitly registered launch profiles

Design an extensible adapter interface for adding other engines, including SGLang, without changing the core controller.

Model states must be distinguished accurately:

`installed`, `configured`, `starting`, `loaded`, `serving`, `stopping`, `stopped`, `failed`, `unknown`, `unreachable`.

An installed model is not necessarily loaded. A running process is not necessarily ready to serve inference.

Never fabricate state when discovery fails.

### 3.3 Model Lifecycle Operations

The primary interaction is selecting a node or cluster, selecting an available model, and clicking **Switch Model**.

Required controls:

- Start Model
- Stop Model
- Switch Model
- Reload Model
- View Logs
- Refresh Model Inventory

The switching workflow must:

1. Confirm the target node or cluster is reachable