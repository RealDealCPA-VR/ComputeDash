import { useTranslation } from "react-i18next";
import type { FleetTarget } from "../../api/fleetTypes";
import { Tag } from "../ui/Tag";
import { formatMemory, targetHealthLabel, targetHealthTone } from "./modelStateTone";

interface TargetListProps {
  targets: FleetTarget[];
  selectedId: string | null;
  onSelect: (targetId: string) => void;
}

/** Nodes first, then clusters; each with health, busy state and (for clusters) what kind of cluster it is. */
export function TargetList({ targets, selectedId, onSelect }: TargetListProps) {
  const { t } = useTranslation("models");
  const nodes = targets.filter((x) => x.kind === "node");
  const clusters = targets.filter((x) => x.kind === "cluster");

  const clusterKindLabel = (target: FleetTarget) => {
    switch (target.clusterKind) {
      case "distributed": return t("targets.kindDistributed");
      case "group": return t("targets.kindGroup");
      default: return t("targets.kindCluster");
    }
  };

  const platformLabel = (target: FleetTarget) => {
    switch (target.platform) {
      case "linux": return t("platform.linux");
      case "darwin": return t("platform.darwin");
      case "windows": return t("platform.windows");
      default: return null;
    }
  };

  /** Which models serve: the first name and "+N" (servingModels), else the count from older servers. */
  const servingLabel = (target: FleetTarget) => {
    if (target.servingModels !== undefined) {
      const models = target.servingModels;
      if (models == null) return t("targets.servingUnknown");
      if (models.length === 0) return t("targets.servingNone");
      if (models.length === 1) return t("targets.servingOne", { model: models[0] });
      return t("targets.servingMore", { model: models[0], more: models.length - 1 });
    }
    return target.servingCount == null ? t("targets.servingUnknown") : t("targets.serving", { count: target.servingCount });
  };
  const servingUnknown = (target: FleetTarget) =>
    target.servingModels !== undefined ? target.servingModels === null : target.servingCount == null;
  const servingTitle = (target: FleetTarget) =>
    target.servingModels && target.servingModels.length > 1 ? t("targets.servingList", { models: target.servingModels.join(", ") }) : undefined;

  const item = (target: FleetTarget) => {
    const selected = target.targetId === selectedId;
    const platform = platformLabel(target);
    const running = target.busy || Boolean(target.activeOperationId);
    return (
      <li key={target.targetId}>
        <button
          type="button"
          className={`mm-target${selected ? " is-active" : ""}`}
          aria-current={selected ? "true" : undefined}
          data-target-id={target.targetId}
          onClick={() => onSelect(target.targetId)}
        >
          <span className="mm-target__head">
            <span className="mm-target__name">{target.name}</span>
            <Tag tone={targetHealthTone(target.health)} className={`mm-health mm-health--${target.health}`}>
              {targetHealthLabel(t, target.health)}
            </Tag>
          </span>
          <span className="mm-target__meta">
            {target.kind === "cluster" ? (
              <span className={`mm-kind mm-kind--${target.clusterKind ?? "unknown"}`}>{clusterKindLabel(target)}</span>
            ) : null}
            {platform ? <span>{platform}</span> : null}
            {target.hardware.label ? <span>{target.hardware.label}</span> : null}
            <span>{t("targets.memory", { memory: formatMemory(target.hardware.memoryTotalBytes, t("unknown")) })}</span>
          </span>
          <span className="mm-target__meta">
            <span className={`mm-target__serving${servingUnknown(target) ? " mm-unknown" : ""}`} title={servingTitle(target)}>
              {servingLabel(target)}
            </span>
            {running ? (
              <Tag tone="acc" className="mm-busy">
                <span className="mm-busy__dot" aria-hidden="true" />
                {t("targets.busy")}
              </Tag>
            ) : null}
          </span>
        </button>
      </li>
    );
  };

  return (
    <nav className="panel mm-targets" aria-label={t("targets.aria")}>
      <h2 className="mm-targets__label">{t("targets.nodes")}</h2>
      {nodes.length ? <ul className="mm-targets__list">{nodes.map(item)}</ul> : <p className="mm-faint">{t("targets.noNodes")}</p>}
      <h2 className="mm-targets__label">{t("targets.clusters")}</h2>
      {clusters.length ? <ul className="mm-targets__list">{clusters.map(item)}</ul> : <p className="mm-faint">{t("targets.noClusters")}</p>}
    </nav>
  );
}
