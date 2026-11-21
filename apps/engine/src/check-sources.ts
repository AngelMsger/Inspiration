/** Read one selected page per vendor with the local app's connectors, before importing or calling any model. */
import { parseArgs } from "node:util";
import type { ConnectorFactory, CreateConnection, Principal } from "@inspiration/contracts";
import { MemoryBlobStore, registry } from "@inspiration/kernel";
import { connectionSecret, localSource } from "./connections.ts";

const usage = "pnpm local:check-sources [--space HR --page 12345] [--feishu https://company.feishu.cn/wiki/...]";

async function check(request: CreateConnection) {
  // The connector needs a source identity, even though this check stores nothing.
  const owner: Principal = { kind: "member", tenant_id: "ten_00000000LOCAL", id: "mem_00000000OWNER" };
  const source = localSource(owner, "spc_00000000CHECK", request);
  const factory = await registry("connectors").get<ConnectorFactory>(source.type);
  const connector = factory(source, { blobs: new MemoryBlobStore(), secret: connectionSecret });
  const [page] = (await connector.list(source.scope)).items;
  if (!page) throw new Error("the selected page was not listed");
  const doc = await connector.fetch(page.ref);
  if ("unchanged" in doc) throw new Error("the connector returned no document on the first read");
  const size = doc.file ? `${doc.file.size_bytes} HTML bytes` : `${doc.blocks?.length ?? 0} top-level blocks`;
  console.log(`${request.name}: fetched revision ${doc.version.external_version} (${size}).`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      space: { type: "string" },
      page: { type: "string" },
      feishu: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) return console.log(usage);
  if (Boolean(values.space) !== Boolean(values.page) || (!values.page && !values.feishu)) throw new Error(usage);
  const requests: CreateConnection[] = [];
  if (values.space && values.page)
    requests.push({
      type: "confluence",
      name: "Confluence",
      targets: [values.space],
      page_ids: [values.page],
      governance_level: "reference",
    });
  if (values.feishu)
    requests.push({ type: "feishu.docx", name: "Feishu", targets: [values.feishu], governance_level: "reference" });
  process.env.INSPIRATION_LOCAL_CONNECTIONS = "1";
  for (const request of requests) {
    try {
      await check(request);
    } catch (error) {
      console.error(`${request.name}: ${error instanceof Error ? error.message : "access check failed"}`);
      process.exitCode = 1;
    }
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : usage);
  process.exitCode = 1;
});
