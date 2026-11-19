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

  const servingLabel = (target: FleetTarget) =>
    target.servingCount == null ? t("targets.servingUnknown") : t("targets.serving", { count: target.servingCount });

  const item = (target: FleetTarget) => {
    const selected = target.targetId === selectedId;
    const platform = platformLabel(target);
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
            <span>{servingLabel(target)}</span>
            {target.busy ? (
              <Tag tone="acc" className="mm-busy">
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
