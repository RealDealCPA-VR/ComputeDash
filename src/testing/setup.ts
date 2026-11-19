import { afterEach } from "vitest";
import { cleanupRenders } from "./render";
import { preloadLocale } from "../i18n";

// zh-CN is loaded on demand in the app; tests switch languages synchronously (a click, then an
// assertion), so its catalogs are in the store from the start.
await preloadLocale("zh-CN");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanupRenders();
  document.body.replaceChildren();
  document.documentElement.removeAttribute("data-density");
});
