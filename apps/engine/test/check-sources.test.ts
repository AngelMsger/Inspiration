import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { expect, test } from "vitest";

test("the local check reads only the selected page and reports an independent missing credential", async () => {
  const credential = randomBytes(24).toString("hex");
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(req.url ?? "");
    if (req.headers.authorization !== `Bearer ${credential}`) return res.writeHead(403).end();
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        id: "12",
        title: "Private title",
        space: { key: "HR" },
        ancestors: [],
        version: { number: 3, when: "2026-11-01T00:00:00Z" },
        body: { view: { value: "<p>Private content</p>" } },
      }),
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const args = ["apps/engine/src/check-sources.ts", "--space", "HR", "--page", "12"];
    const options = {
      env: {
        ...process.env,
        INSPIRATION_CONFLUENCE_TOKEN: credential,
        INSPIRATION_CONFLUENCE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/wiki`,
        INSPIRATION_FEISHU_APP_ID: "",
        INSPIRATION_FEISHU_APP_SECRET: "",
      },
    };
    const run = promisify(execFile);
    const { stdout } = await run(process.execPath, args, options);
    expect(stdout.trim()).toBe("Confluence: fetched revision 3 (22 HTML bytes).");
    await expect(
      run(process.execPath, [...args, "--feishu", "https://example.feishu.cn/wiki/test"], options),
    ).rejects.toMatchObject({ code: 1, stdout, stderr: expect.stringContaining("INSPIRATION_FEISHU_APP_ID") });
    expect(paths).toHaveLength(2);
    expect(paths.every((path) => path.startsWith("/wiki/rest/api/content/12?"))).toBe(true);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});
