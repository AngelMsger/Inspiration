/** The only local PAT operations are listing current pages and reading one page by ID. */
import type { ConnectorContext } from "@inspiration/contracts";
import { ConnectionError, connectionUrl, remoteJson } from "./http.ts";

function localConfluenceAccess() {
  const site = process.env.INSPIRATION_CONFLUENCE_URL;
  const token = process.env.INSPIRATION_CONFLUENCE_TOKEN;
  return process.env.INSPIRATION_LOCAL_CONNECTIONS === "1" && site && token ? { site, token } : undefined;
}

export function hasLocalConfluenceAccess(): boolean {
  return !!localConfluenceAccess();
}

/** The page connector receives this reader. Only the HTTP boundary handles its local PAT. */
export function confluencePageReader(site: URL, credential: string, ctx: Pick<ConnectorContext, "secret">) {
  const content = new URL("rest/api/content", site);
  return async <T>(page: { id: string } | { start: number; space: string }, schema: object): Promise<T> => {
    const url = new URL(content.href);
    if ("id" in page) {
      if (typeof page.id !== "string" || !/^\d+$/.test(page.id)) throw new RangeError("invalid Confluence page ID");
      url.pathname += `/${page.id}`;
      url.searchParams.set("expand", "version,body.view,ancestors,space");
    } else {
      if (!page.space || !Number.isSafeInteger(page.start) || page.start < 0)
        throw new RangeError("invalid Confluence page listing");
      url.search = new URLSearchParams({
        spaceKey: page.space,
        type: "page",
        status: "current",
        start: String(page.start),
        limit: "25",
      }).toString();
    }
    let token: string;
    if (credential === "local:confluence") {
      const access = localConfluenceAccess();
      if (!access) throw new ConnectionError("Confluence: configure the local site and PAT before reading");
      if (content.href !== new URL("rest/api/content", connectionUrl(access.site)).href)
        throw new ConnectionError("Confluence: this source does not match the configured site's URL");
      token = access.token;
    } else {
      if (credential === "local:feishu") throw new ConnectionError("Confluence: unexpected local credential");
      token = await ctx.secret(credential);
    }
    return remoteJson<T>(
      url,
      { method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/json" } },
      schema,
      "Confluence",
    );
  };
}
