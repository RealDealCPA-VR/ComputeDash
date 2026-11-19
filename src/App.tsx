import { BenchIcon } from "./components/bench/BenchIcon";
import { setConfiguredTimeZone } from "./shared/timeZone";
import { lazy, Suspense, useState, useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useBenchLabels } from "./components/shell/useBenchLabels";
import { useSnapshot } from "./hooks/useSnapshot";
import { useFleetAlerts } from "./hooks/useFleetAlerts";
import { useBrowserAlerts } from "./hooks/useBrowserAlerts";
import { useAppRoute, useRoute } from "./hooks/useRoute";
import { useSmoothWheel } from "./hooks/useSmoothWheel";
import { fetchSparks, reorderSparks, fetchSettings, fetchHealth } from "./api/client";
import { AppSidebar } from "./components/shell/AppSidebar";
import { MobileTabBar } from "./components/shell/MobileTabBar";
import { InstallPrompt } from "./components/shell/InstallPrompt";
import { CommandPalette, type PaletteCommand } from "./components/shell/CommandPalette";
import { openShowcase, showcaseTarget } from "./components/shell/sparkSummary";
import { HermesUpdateDialog } from "./components/SparkPage/HermesUpdateDialog";
import { OverviewPage } from "./components/OverviewPage/OverviewPage";
import { ThemeSwitch } from "./components/ThemeSwitch";
import { PageFallback } from "./components/shell/PageFallback";
import { OperationChip } from "./components/shell/OperationChip";
import { PageErrorBoundary } from "./components/shell/PageErrorBoundary";
import {
  GearIcon,
  GridIcon,
  PlusIcon,
  EditIcon,
  SearchIcon,
  TerminalIcon,
  SunIcon,
  ServerIcon,
  BoltIcon,
  ListIcon,
  PanelLeftIcon,
  TokensIcon,
  ThermometerIcon,
  BotIcon,
  CoinsIcon,
  ExpandIcon,
  KeyIcon,
  DiskIcon,
  LayersIcon,
} from "./components/ui/icons";
import { ConnectionBanner, useTelemetryStale } from "./components/ui/ConnectionBanner";
import { ErrorBanner } from "./components/ui/ErrorBanner";
import {
  ACTIVITY_ID,
  STORAGE_ID,
  SHOWCASE_ID,
  ENERGY_ID,
  OVERVIEW_ID,
  TEMPS_ID,
  TOKENS_ID,
  COST_ID,
  KIOSK_ID,
  API_KEYS_ID,
  MODELS_ID,
  benchId,
  benchTypeOf,
  idToPath,
  isPageId,
  isStaleSparkId,
} from "./constants";
import { modelsHref } from "./components/FleetBoard/fleetBoardModel";
import { withPageTransition } from "./hooks/pageTransition";
import { BENCH_SPARK_KEY, NAV_BENCH_TYPES } from "./components/bench/benchCatalog";
import type { AuthMode, Settings, SparkSnapshot } from "./api/types";
import { AccessTokenPrompt } from "./components/AccessTokenDialog";
import { onTokenChange } from "./api/authToken";
import { isWorkerSpark } from "./api/sparkRole";
import { mergeTabOrderKeepingHidden } from "./api/tabOrder";
import { clearSettingsHash, useSettingsHash } from "./hooks/settingsLink";

// Route pages and dialogs load on demand; the Overview and the shell stay in the main bundle.
const SparkPage = lazy(() => import("./components/SparkPage/SparkPage").then((m) => ({ default: m.SparkPage })));
const ShowcasePage = lazy(() => import("./components/ShowcasePage/ShowcasePage").then((m) => ({ default: m.ShowcasePage })));
const ShowcaseView = lazy(() => import("./components/ShowcasePage/ShowcaseView").then((m) => ({ default: m.ShowcaseView })));
const KioskPage = lazy(() => import("./components/KioskPage/KioskPage").then((m) => ({ default: m.KioskPage })));
const TokensPage = lazy(() => import("./components/TokensPage/TokensPage").then((m) => ({ default: m.TokensPage })));
const CostPage = lazy(() => import("./components/CostPage/CostPage").then((m) => ({ default: m.CostPage })));
const ApiKeysPage = lazy(() => import("./components/ApiKeysPage/ApiKeysPage").then((m) => ({ default: m.ApiKeysPage })));
const ModelsPage = lazy(() => import("./components/ModelsPage/ModelsPage").then((m) => ({ default: m.ModelsPage })));
const EnergyPage = lazy(() => import("./components/EnergyPage/EnergyPage").then((m) => ({ default: m.EnergyPage })));
const TempsPage = lazy(() => import("./components/TempsPage/TempsPage").then((m) => ({ default: m.TempsPage })));
const ActivityPage = lazy(() => import("./components/ActivityPage/ActivityPage").then((m) => ({ default: m.ActivityPage })));
const StoragePage = lazy(() => import("./components/StoragePage/StoragePage").then((m) => ({ default: m.StoragePage })));
const BenchPage = lazy(() => import("./components/bench/BenchPage").then((m) => ({ default: m.BenchPage })));
const AddSparkDialog = lazy(() => import("./components/AddSparkDialog").then((m) => ({ default: m.AddSparkDialog })));
const EditSparkDialog = lazy(() => import("./components/EditSparkDialog").then((m) => ({ default: m.EditSparkDialog })));
const SettingsDialog = lazy(() => import("./components/SettingsDialog").then((m) => ({ default: m.SettingsDialog })));
const HarnessWizard = lazy(() => import("./components/HarnessWizard").then((m) => ({ default: m.HarnessWizard })));

/** True from the first time `open` is true: a lazy dialog mounts on first use and then stays, keeping its close animation. */
function useOpenedOnce(open: boolean): boolean {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return opened || open;
}

function placeholderSnapshot(
  id: string,
  name: string,
  disabledDevices: string[] = [],
  disabledInterfaces: string[] = [],
  llmPorts: number[] = [8888],
  roleFields?: {
    role?: SparkSnapshot["role"];
    workerNode?: boolean;
    workerLabel?: string | null;
    workerHeadId?: string | null;
    llmMonitoring?: boolean;
    comfyMonitoring?: boolean;
    comfyPort?: number;
    tailscaleMonitoring?: boolean;
    atticMonitoring?: boolean;
    kind?: "spark" | "host" | "mac";
  }
): SparkSnapshot {
  const role =
    roleFields?.role === "head" ||
    roleFields?.role === "worker" ||
    roleFields?.role === "standalone"
      ? roleFields.role
      : roleFields?.workerNode
        ? "worker"
        : "standalone";
  const workerNode = role === "worker";
  return {
    id,
    name,
    kind: roleFields?.kind ?? "spark",
    online: false,
    uptime: null,
    disabledDevices,
    disabledInterfaces,
    llmPort: llmPorts[0] ?? 8888,
    llmPorts,
    workerNode,
    role,
    workerLabel: workerNode ? roleFields?.workerLabel ?? null : null,
    workerHeadId: workerNode ? roleFields?.workerHeadId ?? null : null,
    llmMonitoring:
      role === "worker"
        ? false
        : role === "head"
          ? true
          : roleFields?.llmMonitoring !== false,
    comfyMonitoring: Boolean(roleFields?.comfyMonitoring),
    comfyPort: roleFields?.comfyPort ?? 8188,
    tailscaleMonitoring: Boolean(roleFields?.tailscaleMonitoring),
    atticMonitoring: Boolean(roleFields?.atticMonitoring),
    hermes: {
      monitoring: false,
      installed: null,
      version: null,
      updateAvailable: null,
      behindCommits: null,
      checkedAt: null,
      status: "idle",
      startedAt: null,
      finishedAt: null,
      error: null,
    },
    hardware: {
      device: "NVIDIA DGX Spark",
      cpuModel: "…",
      cpuCores: 0,
      totalMemoryGB: 0,
      gpuChip: "…",
      cudaDriver: null,
      storageModel: null,
    },
    metrics: {
      gpu: null,
      cpu: null,
      ram: null,
      storage: [],
      network: null,
      unifiedMemory: null,
      llm: [],
      comfy: null,
      tailscale: null,
      attic: null,
    },
  };
}

/** How long the first WebSocket snapshot may take before the REST list is asked instead. */
const FALLBACK_PROBE_MS = 3_000;

function DashboardApp() {
  const { t } = useTranslation("shell");
  const benchLabels = useBenchLabels();
  const {
    sparks: snapSparks,
    activeId,
    setActiveId,
    activeSpark: liveActive,
    connected,
    lastValidSnapshotAt,
    snapshotError,
    refreshInterval,
    serverAlerts,
  } = useSnapshot();
  const sparks = snapSparks;
  const activeSpark = liveActive;
  const { navigate, replace } = useRoute(setActiveId, activeId);
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  // A "#settings/<section>" link (e.g. the Energy page's price hint) opens Settings at that section.
  const [settingsSection, setSettingsSection] = useState<string | null>(null);
  const openSettingsAt = useCallback((section: string | null) => {
    setSettingsSection(section);
    setShowSettings(true);
  }, []);
  useSettingsHash(openSettingsAt);
  const closeSettings = useCallback(() => {
    clearSettingsHash();
    setSettingsSection(null);
    setShowSettings(false);
  }, []);
  const [showHarness, setShowHarness] = useState(false);
  const [harnessSparkId, setHarnessSparkId] = useState<string | undefined>();
  // Desktop sidebar can be hidden to give the page the full width; remembered per browser.
  const [sideHidden, setSideHidden] = useState(() => {
    try {
      return localStorage.getItem("sparkdash.sidebar.hidden") === "1";
    } catch {
      return false;
    }
  });
  const toggleSidebar = useCallback(() => {
    setSideHidden((v) => {
      const next = !v;
      try {
        localStorage.setItem("sparkdash.sidebar.hidden", next ? "1" : "0");
      } catch {
        /* storage blocked: it still toggles for this session */
      }
      return next;
    });
  }, []);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode | null>(null);
  /** Version the running server reports; Settings falls back to this page's own build. */
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const [actionError, setActionError] = useState<{
    kind: "settings" | "refresh" | "reorder";
    detail: string;
  } | null>(null);
  const actionErrorMessage = actionError == null ? null
    : actionError.kind === "settings" ? t("app.settingsError", { detail: actionError.detail })
    : actionError.kind === "refresh" ? t("app.refreshError", { detail: actionError.detail })
    : t("app.reorderError", { detail: actionError.detail });
  /** Used when WS is down so add/delete still updates the tab bar */
  const [fallbackSparks, setFallbackSparks] = useState<SparkSnapshot[]>([]);
  /** True once the REST list has answered, so an empty fleet is known when the WebSocket never delivers. */
  const [fallbackLoaded, setFallbackLoaded] = useState(false);
  const staleAfterMs = Math.max(10_000, 3 * (refreshInterval ?? 2_000));
  // One timeout per snapshot, not a per-second clock: the tree re-renders only when this flips.
  const telemetryStale = useTelemetryStale(lastValidSnapshotAt, staleAfterMs);

  // Prefer live WS data; fall back to API-fetched list when empty
  const liveSparks = sparks.length > 0 ? sparks : fallbackSparks;
  /** Optimistic tab order while drag-save races the next WS snapshot */
  const [orderOverride, setOrderOverride] = useState<string[] | null>(null);

  const displaySparks = useMemo(() => {
    if (!orderOverride?.length) return liveSparks;
    const map = new Map(liveSparks.map((s) => [s.id, s]));
    const ordered: SparkSnapshot[] = [];
    for (const id of orderOverride) {
      const s = map.get(id);
      if (s) {
        ordered.push(s);
        map.delete(id);
      }
    }
    for (const s of map.values()) ordered.push(s);
    return ordered;
  }, [liveSparks, orderOverride]);

  // Tab badge + desktop notifications (both opt-in, per browser): the strip's own
  // list, every alert whatever the strip shows. Live snapshots only — placeholders from the REST fallback are all "offline".
  const fleetAlerts = useFleetAlerts({
    sparks,
    alertsEnabled: settings?.alertsEnabled ?? false,
    serverAlerts,
    temperatureUnit: settings?.temperatureUnit ?? "celsius",
  });
  useBrowserAlerts(fleetAlerts.rows, fleetAlerts.ready && settings != null, fleetAlerts.source);

  // Drop override once server/WS order matches
  useEffect(() => {
    if (!orderOverride) return;
    const live = liveSparks.map((s) => s.id).join("\0");
    if (live === orderOverride.join("\0")) setOrderOverride(null);
  }, [liveSparks, orderOverride]);


  const isOverview = activeId === OVERVIEW_ID;
  const apiKeysEnabled = settings?.apiKeysEnabled === true;
  // Fleet Model Manager: on unless Settings turns it off.
  const fleetModelsEnabled = settings?.fleetModelsEnabled !== false;
  const onPage = isPageId(activeId);
  const benchType = benchTypeOf(activeId);
  const hideWorkers = settings?.hideWorkers ?? false;
  // Charts read the time zone from a module value; set it before the pages render, and
  // re-key <main> below so a change in Settings redraws them.
  const chartTimeZone = settings?.timeZone ?? "";
  setConfiguredTimeZone(chartTimeZone);
  const hiddenWorkerIds = useMemo(() => {
    if (!hideWorkers) return new Set<string>();
    return new Set(
      displaySparks
        .filter((s) => isWorkerSpark(s) && s.id !== activeId)
        .map((s) => s.id)
    );
  }, [displaySparks, hideWorkers, activeId]);
  const tabSparks = useMemo(
    () => (hideWorkers ? displaySparks.filter((s) => !hiddenWorkerIds.has(s.id)) : displaySparks),
    [displaySparks, hideWorkers, hiddenWorkerIds]
  );
  // No silent fallback to another Spark: that would show it under a URL that names a different one.
  const displayActive = onPage
    ? null
    : displaySparks.find((s) => s.id === activeId) || activeSpark || null;
  // The REST list answered (even with no machines): the fleet is known without a WebSocket snapshot.
  const fleetLoaded = lastValidSnapshotAt != null || fallbackSparks.length > 0 || fallbackLoaded;
  const staleSpark = isStaleSparkId(
    activeId,
    displaySparks.map((s) => s.id),
    fleetLoaded
  );

  // The active Spark is gone (deleted, renamed id, bad deep link): fix the URL to the Overview
  // in place, so Back does not return to a page that no longer exists.
  useEffect(() => {
    if (staleSpark) replace(OVERVIEW_ID);
  }, [staleSpark, replace]);

  useEffect(() => {
    if (sparks.length > 0) setFallbackSparks([]);
  }, [sparks]);

  // Fetch global settings on mount, and again when a new access token is
  // saved (the first load may have been refused for the missing token).
  useEffect(() => {
    const load = (afterTokenChange: boolean) =>
      fetchSettings()
        .then((s) => {
          setSettings(s);
          if (afterTokenChange) setActionError(null);
        })
        .catch((err) =>
          setActionError({ kind: "settings", detail: err instanceof Error ? err.message : String(err) })
        );
    void load(false);
    return onTokenChange((token) => {
      if (token) void load(true);
    });
  }, []);

  // Auth posture once on load — drives the "Open access" header warning.
  useEffect(() => {
    fetchHealth()
      .then((h) => {
        setAuthMode(h.authMode);
        setServerVersion(h.version ?? null);
      })
      .catch(() => {
        setAuthMode(null);
        setServerVersion(null);
      });
  }, []);

  const handleSettingsSaved = useCallback((s: Settings) => {
    setSettings(s);
  }, []);

  // One layout density: compact. (The old per-browser "comfortable" option is gone, so a saved
  // value from before cannot leave anyone on a layout they can no longer change.)
  useEffect(() => {
    document.documentElement.setAttribute("data-density", "compact");
  }, []);

  const refreshFromApi = useCallback(async ({ quiet = false }: { quiet?: boolean } = {}) => {
    try {
      const { sparks: configs } = await fetchSparks();
      setFallbackLoaded(true);
      setFallbackSparks(
        configs.map((c) => {
          const existing = sparks.find((s) => s.id === c.id);
          if (existing) {
            // Keep live metrics, but never let a stale WS snapshot override
            // role fields that were just saved via the API.
            return {
              ...existing,
              name: c.name,
              role: c.role ?? existing.role,
              workerNode: c.workerNode ?? existing.workerNode,
              workerLabel: c.workerLabel ?? existing.workerLabel,
              workerHeadId: c.workerHeadId ?? existing.workerHeadId,
              llmMonitoring: c.llmMonitoring ?? existing.llmMonitoring,
              comfyMonitoring: c.comfyMonitoring ?? existing.comfyMonitoring,
              comfyPort: c.comfyPort ?? existing.comfyPort,
              tailscaleMonitoring: c.tailscaleMonitoring ?? existing.tailscaleMonitoring,
              atticMonitoring: c.atticMonitoring ?? existing.atticMonitoring,
              disabledDevices: c.disabledDevices || existing.disabledDevices,
              disabledInterfaces: c.disabledInterfaces || existing.disabledInterfaces,
              llmPorts: c.llmPorts ?? existing.llmPorts,
              llmPort: c.llmPorts?.[0] ?? c.llmPort ?? existing.llmPort,
              kind: c.kind ?? existing.kind,
            };
          }
          return placeholderSnapshot(
            c.id,
            c.name,
            c.disabledDevices || [],
            c.disabledInterfaces || [],
            c.llmPorts ?? (c.llmPort ? [c.llmPort] : [8888]),
            {
              role: c.role,
              workerNode: c.workerNode,
              workerLabel: c.workerLabel,
              workerHeadId: c.workerHeadId,
              llmMonitoring: c.llmMonitoring,
              comfyMonitoring: c.comfyMonitoring,
              comfyPort: c.comfyPort,
              tailscaleMonitoring: c.tailscaleMonitoring,
              atticMonitoring: c.atticMonitoring,
              kind: c.kind,
            }
          );
        })
      );
      if (isStaleSparkId(activeId, configs.map((c) => c.id), true)) replace(OVERVIEW_ID);
    } catch (err) {
      console.error("Failed to refresh sparks:", err);
      if (!quiet) setActionError({ kind: "refresh", detail: err instanceof Error ? err.message : String(err) });
    }
  }, [sparks, activeId, replace]);

  // No WebSocket snapshot yet (e.g. a proxy without WebSocket support): ask the REST list once
  // after a grace period, and again when a new access token is saved, so the Overview can leave
  // its first-load skeleton (an empty fleet shows "Add your first machine"). The connection
  // banner already reports the failure, so the probe stays quiet.
  const awaitingFleet = lastValidSnapshotAt == null && !fallbackLoaded;
  useEffect(() => {
    if (!awaitingFleet) return;
    const timer = setTimeout(() => void refreshFromApi({ quiet: true }), FALLBACK_PROBE_MS);
    const unsubscribe = onTokenChange((token) => {
      if (token) void refreshFromApi({ quiet: true });
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [awaitingFleet, refreshFromApi]);

  const handleReorder = useCallback(
    async (orderedIds: string[]) => {
      const next = mergeTabOrderKeepingHidden(displaySparks, orderedIds, hiddenWorkerIds);
      setOrderOverride(next);
      try {
        await reorderSparks(next);
      } catch (err) {
        console.error("Failed to reorder Sparks:", err);
        setOrderOverride(null);
        setActionError({ kind: "reorder", detail: err instanceof Error ? err.message : String(err) });
      }
    },
    [displaySparks, hiddenWorkerIds]
  );

  const [showPalette, setShowPalette] = useState(false);

  // Deep components (e.g. the LLM panel's "Tool Eval" button) navigate without prop drilling.
  useEffect(() => {
    const onNav = (e: Event) => {
      const detail = (e as CustomEvent<string | { id: string; spark?: string }>).detail;
      const id = typeof detail === "string" ? detail : detail?.id;
      const spark = typeof detail === "object" ? detail?.spark : undefined;
      if (spark) {
        try {
          localStorage.setItem(BENCH_SPARK_KEY, spark);
        } catch {
          /* private mode */
        }
      }
      if (typeof id === "string" && id) navigate(id);
    };
    window.addEventListener("sparkdash:navigate", onNav);
    return () => window.removeEventListener("sparkdash:navigate", onNav);
  }, [navigate]);

  // Ctrl/⌘ K opens the palette from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setShowPalette((v) => !v);
      } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "b") {
        // Not while typing in a field, where Ctrl+B may mean something else.
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSidebar]);

  // The opt-in API Keys page does not exist while its setting is off: a deep link lands on Overview.
  useEffect(() => {
    if (settings && activeId === API_KEYS_ID && !apiKeysEnabled) navigate(OVERVIEW_ID);
  }, [settings, activeId, apiKeysEnabled, navigate]);

  // Same for the Models page while fleet model management is turned off.
  useEffect(() => {
    if (settings && activeId === MODELS_ID && !fleetModelsEnabled) navigate(OVERVIEW_ID);
  }, [settings, activeId, fleetModelsEnabled, navigate]);

  /** The Models page, on a target when given (`?target=`); a page already open re-reads it on popstate. */
  const openModels = useCallback(
    (targetId?: string | null) => {
      const href = modelsHref(targetId);
      // Already there: no duplicate history entry, no synthetic popstate.
      if (activeId === MODELS_ID && href === window.location.pathname + window.location.search) return;
      window.history.pushState(null, "", href);
      if (activeId === MODELS_ID) {
        window.dispatchEvent(new PopStateEvent("popstate"));
        return;
      }
      withPageTransition(() => setActiveId(MODELS_ID), { scrollTop: true });
    },
    [activeId, setActiveId]
  );
  const openAdd = useCallback(() => setShowAdd(true), []);
  const targetName = useCallback(
    (targetId: string) => {
      const unitId = targetId.startsWith("node:") ? targetId.slice(5) : null;
      const unit = unitId ? displaySparks.find((s) => s.id === unitId) : null;
      return unit?.name ?? (targetId.startsWith("cluster:") ? targetId.slice(8) : unitId ?? targetId);
    },
    [displaySparks]
  );
  const addOpened = useOpenedOnce(showAdd);
  const editOpened = useOpenedOnce(editId != null);
  const settingsOpened = useOpenedOnce(showSettings);
  const harnessOpened = useOpenedOnce(showHarness);

  const paletteCommands = useMemo<PaletteCommand[]>(() => {
    const cmds: PaletteCommand[] = [
      { id: "nav:overview", group: t("commands.goTo"), label: t("nav.overview"), hint: t("nav.fleet"), icon: <GridIcon className="h-4 w-4" />, keywords: "Overview home fleet", run: () => navigate(OVERVIEW_ID) },
    ];
    cmds.push(
      { id: "nav:tokens", group: t("commands.goTo"), label: t("nav.tokens"), hint: t("commands.page"), icon: <TokensIcon className="h-4 w-4" />, keywords: "Token totals llm tokens generated prompt cached usage", run: () => navigate(TOKENS_ID) },
      { id: "nav:cost", group: t("commands.goTo"), label: t("nav.cost"), hint: t("commands.page"), icon: <CoinsIcon className="h-4 w-4" />, keywords: "Cost compare cost price money usd dollars api hosted opus sonnet gpt gemini compare", run: () => navigate(COST_ID) },
      { id: "nav:energy", group: t("commands.goTo"), label: t("nav.energy"), hint: t("commands.page"), icon: <BoltIcon className="h-4 w-4" />, keywords: "Fleet energy power kwh watts cost electricity", run: () => navigate(ENERGY_ID) },
      { id: "nav:temps", group: t("commands.goTo"), label: t("nav.temps"), hint: t("commands.page"), icon: <ThermometerIcon className="h-4 w-4" />, keywords: "Temps gpu temperature thermal temps heat cooling", run: () => navigate(TEMPS_ID) },
      { id: "nav:showcase", group: t("commands.goTo"), label: t("nav.showcase"), hint: t("commands.page"), icon: <TerminalIcon className="h-4 w-4" />, keywords: "Showcase prompts terminals stream demo", run: () => navigate(SHOWCASE_ID) },
      { id: "nav:activity", group: t("commands.goTo"), label: t("nav.activity"), hint: t("commands.page"), icon: <ListIcon className="h-4 w-4" />, keywords: "Activity events log history recent", run: () => navigate(ACTIVITY_ID) },
      { id: "nav:kiosk", group: t("commands.goTo"), label: t("nav.kiosk"), hint: t("commands.wallDisplay"), icon: <ExpandIcon className="h-4 w-4" />, keywords: "Kiosk wall tv display fullscreen full screen", run: () => window.location.assign(idToPath(KIOSK_ID)) },
      { id: "nav:storage", group: t("commands.goTo"), label: t("nav.storageManager"), hint: t("commands.page"), icon: <DiskIcon className="h-4 w-4" />, keywords: "storage disk space folders files docker images delete clean cleanup du", run: () => navigate(STORAGE_ID) },
    );
    for (const s of displaySparks) {
      cmds.push({
        id: `nav:${s.id}`,
        group: t("commands.goTo"),
        label: s.name,
        hint: s.online ? t("commands.online") : t("commands.offline"),
        icon: <ServerIcon className="h-4 w-4" />,
        keywords: `spark ${s.id}`,
        run: () => navigate(s.id),
      });
    }
    for (const b of NAV_BENCH_TYPES) {
      cmds.push({
        id: `bench:${b.id}`,
        group: t("commands.benchmarks"),
        label: t("commands.benchmark", { name: benchLabels[b.id].label }),
        hint: b.family,
        icon: <BenchIcon id={b.id} className="h-4 w-4" />,
        keywords: `bench benchmark ${b.label} ${b.blurb} ${benchLabels[b.id].blurb}`,
        run: () => navigate(benchId(b.id)),
      });
    }
    cmds.push({ id: "act:add", group: t("commands.actions"), label: t("commands.add"), icon: <PlusIcon className="h-4 w-4" />, keywords: "Add a Spark or GPU host new register connect", run: () => setShowAdd(true) });
    const sc = showcaseTarget(displaySparks);
    if (sc) {
      cmds.push({ id: "act:showcase", group: t("commands.actions"), label: t("commands.showcase", { name: sc.name }), icon: <TerminalIcon className="h-4 w-4" />, keywords: `Open showcase on ${sc.name} in a new window demo streams terminals`, run: () => openShowcase(sc) });
    }
    if (displayActive) {
      cmds.push({ id: "act:edit", group: t("commands.actions"), label: t("commands.edit", { name: displayActive.name }), icon: <EditIcon className="h-4 w-4" />, keywords: `Edit ${displayActive.name} settings role ports`, run: () => setEditId(displayActive.id) });
    }
    cmds.push(
      { id: "act:theme", group: t("commands.actions"), label: t("commands.theme"), hint: t("commands.themeHint"), icon: <SunIcon className="h-4 w-4" />, keywords: "Switch theme appearance dark light", run: () => window.dispatchEvent(new Event("sparkdash:cycle-theme")) },
      { id: "act:sidebar", group: t("commands.actions"), label: t("commands.sidebar"), icon: <PanelLeftIcon className="h-4 w-4" />, keywords: "Show or hide the sidebar collapse expand navigation rail menu", run: toggleSidebar },
      { id: "act:settings", group: t("commands.actions"), label: t("commands.settings"), icon: <GearIcon className="h-4 w-4" />, keywords: "Open settings preferences density refresh", run: () => setShowSettings(true) },
      { id: "act:harness", group: t("commands.actions"), label: t("commands.harness"), icon: <BotIcon className="h-4 w-4" />, keywords: "Set up harness sessions occupancy openclaw opencode hermes oh-my-pi wizard", run: () => { setHarnessSparkId(undefined); setShowHarness(true); } }
    );
    if (fleetModelsEnabled) {
      cmds.push({ id: "nav:models", group: t("commands.goTo"), label: t("nav.models"), hint: t("commands.page"), icon: <LayersIcon className="h-4 w-4" />, keywords: "models model manager fleet switch start stop reload load unload cluster ollama vllm lm studio llama.cpp mlx", run: () => navigate(MODELS_ID) });
    }
    if (apiKeysEnabled) {
      cmds.push({ id: "nav:apikeys", group: t("commands.goTo"), label: t("nav.apiKeys"), hint: t("commands.page"), icon: <KeyIcon className="h-4 w-4" />, keywords: "api keys litellm virtual keys spend budget", run: () => navigate(API_KEYS_ID) });
    }
    return cmds;
  }, [displaySparks, displayActive, navigate, toggleSidebar, t, benchLabels, apiKeysEnabled, fleetModelsEnabled]);

  return (
    <div className="min-h-screen text-text">
      <div className={`app-shell${sideHidden ? " app-shell--side-hidden" : ""}`}>
        <AppSidebar
          onCollapse={toggleSidebar}
          sparks={displaySparks} // hidden workers stay reachable here
          activeId={displayActive?.id ?? activeId}
          onSelect={navigate}
          onAdd={() => setShowAdd(true)}
          onReorder={handleReorder}
          onOpenSettings={() => setShowSettings(true)}
          onOpenSearch={() => setShowPalette(true)}
          benchType={benchType}
          onSelectBench={(type) => navigate(benchId(type))}
          connected={connected}
          refreshInterval={refreshInterval}
          authMode={authMode}
          showApiKeys={apiKeysEnabled}
          showModels={fleetModelsEnabled}
        />
        <div className="side-strip" aria-hidden={!sideHidden}>
          <button type="button" className="icon-circle" onClick={toggleSidebar} tabIndex={sideHidden ? 0 : -1} title={t("nav.showSidebarTitle")} aria-label={t("nav.showSidebar")}>
            <PanelLeftIcon className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="app-main">
          {/* Phone-only bar: on larger screens search and theme live in the sidebar. */}
          <header className="app-topbar">
            <a
              href={idToPath(OVERVIEW_ID)}
              className="brand"
              aria-label={t("nav.brandOverview")}
              onClick={(e) => {
                if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                navigate(OVERVIEW_ID);
              }}
            >
              <span className="brand__mark">
                <BoltIcon className="h-[17px] w-[17px]" />
              </span>
              <span>
                spark<span className="brand__dash">Dash</span>
              </span>
            </a>
            <button type="button" className="search-trigger" onClick={() => setShowPalette(true)} aria-label={t("nav.openSearch")}>
              <SearchIcon className="h-4 w-4" />
            </button>
            <ThemeSwitch />
          </header>
          <div className={`app-content${activeId === SHOWCASE_ID ? " app-content--wide" : ""}`}>
            <ConnectionBanner
              connected={connected}
              lastValidSnapshotAt={lastValidSnapshotAt}
              snapshotError={snapshotError}
              stale={telemetryStale}
            />
            <OperationChip enabled={fleetModelsEnabled && settings != null} nameOf={targetName} onOpen={openModels} />
            <ErrorBanner message={actionErrorMessage} onDismiss={() => setActionError(null)} />
            <main key={chartTimeZone} className={telemetryStale || !connected ? "telemetry-stale" : undefined}>
              <PageErrorBoundary resetKey={activeId}>
              <Suspense fallback={<PageFallback />}>
              {activeId === TOKENS_ID ? (
                <TokensPage sparks={displaySparks} onSelectSpark={navigate} />
              ) : activeId === COST_ID ? (
                <CostPage />
              ) : activeId === API_KEYS_ID ? (
                apiKeysEnabled ? <ApiKeysPage /> : null
              ) : activeId === MODELS_ID ? (
                fleetModelsEnabled ? <ModelsPage onAddUnit={openAdd} /> : null
              ) : activeId === ENERGY_ID ? (
                <EnergyPage sparks={displaySparks} settings={settings} onSelectSpark={navigate} />
              ) : activeId === TEMPS_ID ? (
                <TempsPage sparks={displaySparks} onSelectSpark={navigate} />
              ) : activeId === ACTIVITY_ID ? (
                <ActivityPage sparks={displaySparks} onSelectSpark={navigate} />
              ) : activeId === STORAGE_ID ? (
                <StoragePage sparks={displaySparks} />
              ) : activeId === SHOWCASE_ID ? (
                <ShowcaseView sparks={displaySparks} />
              ) : benchType ? (
                <BenchPage type={benchType} sparks={displaySparks} benchShareImage={settings?.benchShareImage ?? false} />
              ) : isOverview ? (
                <OverviewPage
                  sparks={displaySparks}
                  hideOffline={settings?.autoHideOffline ?? false}
                  hideWorkers={hideWorkers}
                  showFleetEnergy={settings?.showFleetEnergy ?? true}
                  showInferenceActivity={settings?.inferenceActivityEnabled === true}
                  showFleetExceptions={settings?.showFleetExceptions ?? false}
                  alertsEnabled={settings?.alertsEnabled ?? false}
                  serverAlerts={serverAlerts}
                  showOverviewSearch={settings?.showOverviewSearch ?? false}
                  showLlmTokenTotals={settings?.showLlmTokenTotals ?? true}
                  showActivityFeed={settings?.showActivityFeed ?? true}
                  kpis={{
                    decode: settings?.showKpiDecode ?? true,
                    power: settings?.showKpiPower ?? true,
                    memory: settings?.showKpiMemory ?? true,
                    tokens: settings?.showKpiTokens ?? true,
                  }}
                  showVramBreakdown={settings?.showVramBreakdown ?? true}
                  temperatureUnit={settings?.temperatureUnit ?? "celsius"}
                  onSelectSpark={navigate}
                  onNavigate={navigate}
                  loading={!fleetLoaded}
                  onAddUnit={openAdd}
                  showFleetBoard={fleetModelsEnabled && settings != null}
                  onOpenModels={openModels}
                />
              ) : displayActive ? (
                <SparkPage
                  spark={displayActive}
                  fleet={displaySparks}
                  showVramBreakdown={settings?.showVramBreakdown ?? true}
                  temperatureUnit={settings?.temperatureUnit ?? "celsius"}
                  benchShareImage={settings?.benchShareImage ?? false}
                  metricsHistory={settings?.metricsHistory ?? false}
                  onEdit={() => setEditId(displayActive.id)}
                  onNavigate={navigate}
                  onAddHarness={() => {
                    setHarnessSparkId(displayActive.id);
                    setShowHarness(true);
                  }}
                />
              ) : !fleetLoaded || staleSpark ? null : (
                <div className="panel mx-auto mt-16 max-w-md p-8 text-center">
                  <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-accent-soft text-accent">
                    <PlusIcon className="h-5 w-5" />
                  </div>
                  <h2 className="text-sm font-semibold text-text-strong">{t("app.emptyTitle")}</h2>
                  <p className="mt-1 text-xs text-muted">{t("app.emptyDescription")}</p>
                  <button type="button" className="btn btn--primary mt-4" onClick={() => setShowAdd(true)}>
                    <PlusIcon className="h-3.5 w-3.5" />
                    {t("app.addSpark")}
                  </button>
                </div>
              )}
              </Suspense>
              </PageErrorBoundary>
            </main>
          </div>
        </div>
      </div>
      <MobileTabBar
        sparks={tabSparks}
        activeId={displayActive?.id ?? activeId}
        onSelect={navigate}
        onAdd={() => setShowAdd(true)}
        onOpenSettings={() => setShowSettings(true)}
        showApiKeys={apiKeysEnabled}
        showModels={fleetModelsEnabled}
      />
      <InstallPrompt />
      <CommandPalette open={showPalette} onClose={() => setShowPalette(false)} commands={paletteCommands} />
      <HermesUpdateDialog />
      {/* Each lazy dialog suspends on its own, so loading one never hides another that is open. */}
      <PageErrorBoundary floating>
      {addOpened ? (
      <Suspense fallback={null}>
      <AddSparkDialog
        open={showAdd}
        onClose={() => setShowAdd(false)}
        onAdded={() => {
          void refreshFromApi();
        }}
        defaultLlmPort={settings?.defaultLlmPort ?? 8888}
      />
      </Suspense>
      ) : null}
      {editOpened ? (
      <Suspense fallback={null}>
      <EditSparkDialog
        open={editId != null}
        sparkId={editId}
        onClose={() => setEditId(null)}
        onSaved={() => {
          void refreshFromApi();
        }}
        onDeleted={(id) => {
          if (activeId === id) {
            const next = displaySparks.find((s) => s.id !== id);
            navigate(next?.id ?? OVERVIEW_ID);
          }
          void refreshFromApi();
        }}
      />
      </Suspense>
      ) : null}
      {settingsOpened ? (
      <Suspense fallback={null}>
      <SettingsDialog
        open={showSettings}
        section={settingsSection}
        onClose={closeSettings}
        onSaved={handleSettingsSaved}
        serverVersion={serverVersion}
        onOpenHarness={() => {
          closeSettings();
          setHarnessSparkId(displayActive?.id);
          setShowHarness(true);
        }}
      />
      </Suspense>
      ) : null}
      {harnessOpened ? (
      <Suspense fallback={null}>
      <HarnessWizard
        open={showHarness}
        onClose={() => setShowHarness(false)}
        sparkId={harnessSparkId}
        sparks={displaySparks.map((spark) => ({
          id: spark.id,
          name: spark.name,
          llmPorts: spark.llmPorts?.length ? spark.llmPorts : [spark.llmPort],
        }))}
      />
      </Suspense>
      ) : null}
      </PageErrorBoundary>
    </div>
  );
}

function App() {
  const route = useAppRoute();
  useSmoothWheel();
  return (
    <>
      {route.mode === "showcase" && route.showcaseSparkId ? (
        <PageErrorBoundary>
          <Suspense fallback={<PageFallback />}>
            <ShowcasePage sparkId={route.showcaseSparkId} />
          </Suspense>
        </PageErrorBoundary>
      ) : route.mode === "kiosk" ? (
        <PageErrorBoundary>
          <Suspense fallback={<PageFallback />}>
            <KioskPage />
          </Suspense>
        </PageErrorBoundary>
      ) : (
        <DashboardApp />
      )}
      <AccessTokenPrompt />
    </>
  );
}

export default App;
