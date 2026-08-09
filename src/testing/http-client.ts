/** 轻量 HTTP 调用包装 —— 对 in-process app.fetch 或真实 URL。 */

export type Json = Record<string, unknown>;

export type TestFetch = (
  path: string,
  init?: RequestInit & { accountId?: string; adminToken?: string },
) => Promise<Json>;

export function createAppFetch(
  app: { fetch: (req: Request) => Response | Promise<Response> },
): TestFetch {
  return async (path, init = {}) => {
    const headers = new Headers(init.headers);
    if (!headers.has("content-type") && init.body) {
      headers.set("content-type", "application/json");
    }
    if (init.accountId) headers.set("x-account-id", init.accountId);
    if (init.adminToken) headers.set("x-admin-token", init.adminToken);
    const res = await app.fetch(new Request("http://test-user" + path, { ...init, headers }));
    const body = (await res.json().catch(() => ({}))) as Json;
    return { ...body, __status: res.status };
  };
}
