/**
 * Hermetic fetch for fleet tests. Routes map "METHOD url" to:
 *   { status?, body?, text? }  → a real Response (body is JSON-serialized)
 *   Error                       → a rejected fetch (connection failure)
 *   "hang"                      → never answers until the request is aborted
 *   (init) => route             → computed per call
 * Unrouted requests reject with ECONNREFUSED. Every call is recorded in `calls`.
 */
export function fakeFetch(routes = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const method = init.method || "GET";
    calls.push({ method, url, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers, redirect: init.redirect });
    let route = routes[`${method} ${url}`];
    if (typeof route === "function") route = route(init);
    if (route === undefined) {
      const err = new TypeError("fetch failed");
      err.cause = { code: "ECONNREFUSED" };
      throw err;
    }
    if (route instanceof Error) throw route;
    if (route === "hang") {
      return new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    }
    const status = route.status ?? 200;
    const text = route.text !== undefined ? route.text : route.body === undefined ? "" : JSON.stringify(route.body);
    return new Response(status === 204 ? null : text, { status, headers: route.headers ?? {} });
  };
  impl.calls = calls;
  return impl;
}
