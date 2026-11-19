// Simplified Chinese catalogs, loaded on demand (one chunk) when the language is switched to zh-CN.
// English stays bundled in index.ts as the source of truth and fallback.
import settings from "../locales/zh-CN/settings.json";
import language from "../locales/zh-CN/language.json";
import shell from "../locales/zh-CN/shell.json";
import overview from "../locales/zh-CN/overview.json";
import spark from "../locales/zh-CN/spark.json";
import statistics from "../locales/zh-CN/statistics.json";
import activity from "../locales/zh-CN/activity.json";
import devices from "../locales/zh-CN/devices.json";
import hardware from "../locales/zh-CN/hardware.json";
import benchmarks from "../locales/zh-CN/benchmarks.json";
import tooleval from "../locales/zh-CN/tooleval.json";
import toolMessages from "../locales/zh-CN/toolMessages.json";
import shareCards from "../locales/zh-CN/shareCards.json";
import showcase from "../locales/zh-CN/showcase.json";
import apiKeys from "../locales/zh-CN/apiKeys.json";
import storage from "../locales/zh-CN/storage.json";
import models from "../locales/zh-CN/models.json";

const catalogs: Record<string, object> = {
  settings,
  language,
  shell,
  overview,
  spark,
  statistics,
  activity,
  devices,
  hardware,
  benchmarks,
  tooleval,
  toolMessages,
  shareCards,
  showcase,
  apiKeys,
  storage,
  models,
};

export default catalogs;
