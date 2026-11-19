import { createInstance, type BackendModule, type ReadCallback } from "i18next";
import { initReactI18next } from "react-i18next";
import enSettings from "../locales/en/settings.json";
import enLanguage from "../locales/en/language.json";
import enShell from "../locales/en/shell.json";
import enOverview from "../locales/en/overview.json";
import enSpark from "../locales/en/spark.json";
import enStatistics from "../locales/en/statistics.json";
import enActivity from "../locales/en/activity.json";
import enDevices from "../locales/en/devices.json";
import enHardware from "../locales/en/hardware.json";
import enBenchmarks from "../locales/en/benchmarks.json";
import enTooleval from "../locales/en/tooleval.json";
import enToolMessages from "../locales/en/toolMessages.json";
import enShareCards from "../locales/en/shareCards.json";
import enShowcase from "../locales/en/showcase.json";
import enApiKeys from "../locales/en/apiKeys.json";
import enStorage from "../locales/en/storage.json";
import enModels from "../locales/en/models.json";

export type Locale = "en" | "zh-CN";
export const LOCALE_STORAGE_KEY = "sparkdash-locale";

export function normalizeLocale(value: string | null | undefined): Locale | null {
  if (!value) return null;
  const tag = value.toLowerCase().replace(/_/g, "-");
  if (tag === "en" || tag.startsWith("en-")) return "en";
  if (tag === "zh" || tag === "zh-cn" || tag === "zh-sg" || tag === "zh-my" || tag === "zh-hans" || tag.startsWith("zh-hans-")) return "zh-CN";
  return null;
}

export function detectLocale(): Locale {
  try {
    const stored = normalizeLocale(localStorage.getItem(LOCALE_STORAGE_KEY));
    if (stored) return stored;
  } catch { /* Browser storage is optional. */ }
  return normalizeLocale(typeof navigator === "undefined" ? null : navigator.language) ?? "en";
}

// English catalogs are the source of truth and the fallback, so they are bundled. Other
// languages are fetched on demand (one chunk per language) the first time they are used.
const EN_CATALOGS = {
  settings: enSettings,
  language: enLanguage,
  shell: enShell,
  overview: enOverview,
  spark: enSpark,
  activity: enActivity,
  statistics: enStatistics,
  devices: enDevices,
  hardware: enHardware,
  shareCards: enShareCards,
  toolMessages: enToolMessages,
  tooleval: enTooleval,
  benchmarks: enBenchmarks,
  showcase: enShowcase,
  apiKeys: enApiKeys,
  storage: enStorage,
  models: enModels,
};
const NAMESPACES = Object.keys(EN_CATALOGS);

type Catalogs = Record<string, object>;
const LAZY_LOCALES: Record<string, () => Promise<Catalogs>> = {
  "zh-CN": () => import("./zh-CN").then((module) => module.default),
};
const pending = new Map<string, Promise<Catalogs>>();

/** All of a language's catalogs, imported once; a failed import may be retried by the next switch. */
function loadCatalogs(language: string): Promise<Catalogs> | null {
  const loader = LAZY_LOCALES[language];
  if (!loader) return null;
  let promise = pending.get(language);
  if (!promise) {
    promise = loader().catch((error: unknown) => {
      pending.delete(language);
      throw error;
    });
    pending.set(language, promise);
  }
  return promise;
}

/** i18next backend reading the on-demand catalogs. changeLanguage() resolves after they are in. */
const lazyCatalogBackend: BackendModule = {
  type: "backend",
  init() {},
  read(language: string, namespace: string, callback: ReadCallback) {
    const catalogs = loadCatalogs(language);
    // Unknown language (or English, which is bundled): nothing to load, English is the fallback.
    if (!catalogs) {
      callback(null, {});
      return;
    }
    catalogs.then(
      (all) => callback(null, (all[namespace] ?? {}) as Record<string, unknown>),
      (error: unknown) => callback(error instanceof Error ? error : new Error(String(error)), false)
    );
  },
};

export const i18n = createInstance();
/** Resolves once the starting language's catalogs are available (immediately for English). */
export const i18nReady: Promise<unknown> = i18n.use(lazyCatalogBackend).use(initReactI18next).init({
  resources: { en: EN_CATALOGS },
  partialBundledLanguages: true,
  lng: detectLocale(),
  fallbackLng: "en",
  supportedLngs: ["en", "zh-CN"],
  load: "currentOnly",
  defaultNS: "settings",
  ns: NAMESPACES,
  interpolation: { escapeValue: false },
  returnEmptyString: false,
  initAsync: false,
}).catch(() => undefined);

function updateDocumentLanguage() {
  if (typeof document !== "undefined") document.documentElement.lang = i18n.resolvedLanguage ?? "en";
}
i18n.on("languageChanged", updateDocumentLanguage);
updateDocumentLanguage();

/** Loads the language's catalogs (when not bundled), then switches to it and remembers the choice. */
export async function setLocale(locale: Locale): Promise<void> {
  await i18n.changeLanguage(locale);
  try { localStorage.setItem(LOCALE_STORAGE_KEY, locale); } catch { /* Switching still works without storage. */ }
}

/**
 * Adds a language's catalogs to the store without switching to it, so a later switch is
 * synchronous. Used by the test setup; harmless (one cached import) anywhere else.
 */
export async function preloadLocale(locale: Locale): Promise<void> {
  const catalogs = loadCatalogs(locale);
  if (!catalogs) return;
  const all = await catalogs;
  for (const [namespace, bundle] of Object.entries(all)) {
    if (!i18n.hasResourceBundle(locale, namespace)) i18n.addResourceBundle(locale, namespace, bundle, true, true);
  }
}
