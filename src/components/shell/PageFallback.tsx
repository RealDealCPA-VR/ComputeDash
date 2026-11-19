import { useTranslation } from "react-i18next";

/** Lightweight placeholder while a lazily loaded page's code arrives. */
export function PageFallback() {
  const { t } = useTranslation("shell");
  return (
    <div className="page-fallback" role="status" aria-busy="true" aria-label={t("nav.pageLoading")}>
      <div className="skel-row">
        <i className="skel-bar skel-bar--s" />
        <i className="skel-bar" />
      </div>
      <div className="skel-row">
        <i className="skel-bar" />
      </div>
      <div className="skel-row">
        <i className="skel-bar" />
        <i className="skel-bar skel-bar--s" />
      </div>
    </div>
  );
}
