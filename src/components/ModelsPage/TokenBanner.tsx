import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { requestTokenPrompt } from "../../api/authToken";

/** Prints a random 64-hex-character token with Node's crypto (Node is already on the dashboard host). */
export const TOKEN_GENERATE_COMMAND = `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`;
export const TOKEN_ENV_LINE = "SPARKDASH_TOKEN=<value>";
export const FLEET_DOCS_URL = "https://github.com/RealDealCPA-VR/ComputeDash/blob/main/docs/FLEET-MODELS.md";

/**
 * Why model control is unavailable for lack of a token:
 * - "server": the dashboard host has no SPARKDASH_TOKEN (or refused with 403 token_required), so
 *   control is locked and the operator has to set one up;
 * - "browser": the host has a token but this browser has not entered it yet.
 */
export type TokenBannerMode = "server" | "browser";

/** One line of shell text with a Copy button. The text stays selectable when the clipboard is unavailable (plain http). */
function CopyLine({ text, label }: { text: string; label: string }) {
  const { t } = useTranslation("models");
  const [state, setState] = useState<"idle" | "ok" | "err">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState("ok");
    } catch {
      setState("err");
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 2000);
  };
  return (
    <span className="mm-cmd">
      <code className="mm-cmd__text">{text}</code>
      <button type="button" className="btn btn--sm btn--ghost mm-cmd__copy" onClick={() => void copy()}>
        {state === "ok" ? t("token.copied") : state === "err" ? t("token.copyFailed") : label}
      </button>
    </span>
  );
}

export function TokenBanner({ mode }: { mode: TokenBannerMode }) {
  const { t } = useTranslation("models");
  if (mode === "browser") {
    return (
      <div className="panel tk-note mm-token-banner mm-token-banner--browser" role="status" data-testid="token-banner-browser">
        <p className="mm-token-banner__text">{t("token.browserBody")}</p>
        <button type="button" className="btn btn--sm btn--primary" onClick={() => requestTokenPrompt()}>
          {t("token.enter")}
        </button>
      </div>
    );
  }
  return (
    <div className="panel tk-note mm-token-banner" role="status" data-testid="token-banner">
      <p className="mm-token-banner__title">{t("token.serverTitle")}</p>
      <p className="mm-token-banner__text">{t("token.serverBody")}</p>
      <ol className="mm-token-steps">
        <li>
          <span>{t("token.stepGenerate")}</span>
          <CopyLine text={TOKEN_GENERATE_COMMAND} label={t("token.copyCommand")} />
        </li>
        <li>
          <span>{t("token.stepEnv")}</span>
          <CopyLine text={TOKEN_ENV_LINE} label={t("token.copyEnvLine")} />
        </li>
        <li>{t("token.stepRestart")}</li>
      </ol>
      <p className="mm-token-banner__foot">
        <span>{t("token.setupHint")}</span>{" "}
        <a href={FLEET_DOCS_URL} target="_blank" rel="noopener noreferrer">
          {t("token.docsLink")}
        </a>
      </p>
    </div>
  );
}
