# Local validation

Run Inspiration on one computer with a persistent database, a local owner, DeepSeek for
reading and answers, and local embeddings and reranking. This profile implements the
product owner's 2026-11-11 decision to validate directly against Confluence Data Center /
Server and Feishu. [中文](zh/local.md).

## Start

Use macOS, Linux, or Windows through WSL2, with Node 22.18+ (24 recommended), pnpm 10.28.0,
Python 3.10+ and Docker Compose. Docker Desktop must be running. Allow several GB for the
local embedding and reranking models; their first use downloads them from Hugging Face.

```bash
make install
npm ci --prefix infra/local-embeddings
cp .env.example .env
# Edit .env locally with your DeepSeek key and the connection credentials below.
pnpm local
```

Open <http://localhost:4200>. Choose **Open Inspiration**, create a company, then create a
space with yourself as its owner. Keep its audience private for your first validation.
The launcher starts the Compose stack, builds the web app, starts the parsing worker when
installed, and starts the model server, engine and business backend. It waits for the app
services to answer and stops its processes together on Ctrl+C. The database, queue, source
versions, blobs, sessions and usage remain; `make down` also keeps Docker volumes.
Do not use `make clean` to stop normal work: it deletes the volumes.

This is an explicit, single-owner local profile, bound to loopback. It does not need Logto
and must not be exposed through a public proxy. Every browser on the computer can enter as
the same owner. Hosted/multiuser operation continues to use the OIDC backend.

Before providing a model key, `pnpm local --mock` rehearses the pipeline with deterministic
stand-ins, a separate Compose project and ports 55432, 56379, 55051 and 58443. Its output is
not evidence of model quality. Keep mock data separate from real model data; do not override
its database or graph to point at a real installation. `--skip-stack` uses already-running
services; it is intended for development. Real mode defaults to the normal Compose ports.

## Connect Confluence

Set `INSPIRATION_CONFLUENCE_URL` to the site root, including `/confluence` when applicable,
and `INSPIRATION_CONFLUENCE_TOKEN` to a personal access token of an account that can read the
chosen space. This profile uses Data Center / Server's `/rest/api/content` API with Bearer
PAT authentication; Cloud, SSO browser cookies and older servers without PAT support are
not supported. For corporate TLS, configure `NODE_EXTRA_CA_CERTS` with the company CA before
starting Node. Connect the VPN if the server requires it; TLS verification stays enabled.

In **Maintain space → Connections**, select Confluence, give the connection a name and
enter one space key (for example `HR`, not the display name). Select a governance level and
choose **Connect and sync**. All pages visible to that account in the space are imported,
with rendered HTML, page ancestry, revision and original URL. Attachments, archived pages
and macros requiring interactive browser state are outside this first connector.

## Connect Feishu

Use a published Feishu internal app. Set `INSPIRATION_FEISHU_APP_ID` and
`INSPIRATION_FEISHU_APP_SECRET`. Grant document read scopes (`docx:document:readonly` or the
corresponding document-read permission shown by the platform), and for wiki links grant
`wiki:wiki:readonly`. Make the app a collaborator of the target document or grant it access
through the wiki. App scopes alone do not grant access to a particular document.

In Connections, choose Feishu and paste full `https://<company>.feishu.cn/docx/<token>` or
`/wiki/<token>` links, one per line. Wiki links resolve to docx documents. These are explicit
pages, not recursive wiki-space imports. Blocks retain their native IDs for citations;
all block pages are fetched at the same document revision. Sheets, Bitable, old `doc`
documents, live approvals and attachment/image OCR are not supported here.

Both connections use the credential's readable view. Imported documents are readable by
this Inspiration space's audience; the upstream document ACL is not replicated. Credentials
stay in `.env`, never in the browser's requests or the source record. Restart the local app
after changing credentials. Original links do not grant additional upstream permissions.

## Complete one validation

1. Connect a small source. Start with a few policies, not the entire company's wiki.
2. Watch the persisted sync result; then open Documents to see parsing, indexing and reading
   progress. A successful sync means the content was fetched; model reading may still be running.
3. Choose **Governed** for policies whose facts should be compared. **Reference** is the
   default for ordinary material: it is searchable immediately after indexing and read more
   deeply where an answer uses it. **Search only** never extracts facts.
4. Ask a question and open its citations. Check both the imported passage and original URL.
5. Change a document upstream, choose **Sync now**, and ask again. Unchanged items do not
   create new versions; changed items retain the previous version and its citations.
6. Add a conflicting governed statement. Check the owner's Inbox, review the evidence and
   resolve it. Newly discovered facts are model proposals, not validated company policy.
7. Restart `pnpm local`, open the same company and check documents, citations and connection
   results again. An interrupted sync is marked failed with a retry instruction. Both sync
   API entry points use the same source-sync job and persisted result; concurrent requests
   join the running import. Confluence listing enumerates pages; fetching reads each current
   page independently, including single-page refreshes. One failed Confluence or Feishu page
   is reported individually while readable pages continue updating, and its last imported
   version is retained.

For an empty company, fact discovery proposes a normalization catalogue from verbatim
passages, separated by space and sensitivity. Ordinary extraction still validates evidence;
governance still requires a person's decision where the rules ask for one. The catalogue is
bounded to 200 discovered predicates per space and sensitivity. Explicit tenant vocabulary
takes precedence and stays separate from discovery state; later reads retain earlier
evidenced aliases. New topics are organized in the background about once a minute and get
the space's first owner; small or unfiled topics also route review work to that owner. Search
and citations are usable before topic organization.

`--discover-facts` controls only catalogue discovery. The HTTP/MCP server enables on-use
reading independently, and space-owner routing and background organization also work with a
supplied catalogue. Extraction resolves passages in the version the citation names, including
unchanged spans reused from older versions. Before answering, the engine applies only that
read's committed events to the existing governance and freshness handlers. Their inbox
idempotency makes later bus delivery safe; answers never drain unrelated background work.

Live Feishu wiki targets use the wiki page token as their stable identity, independently of
the underlying docx token. Sources imported by the earlier draft using resolved docx identities
will be reimported once under wiki identities; historical versions and citations remain.

## Diagnose

- **Connection unavailable:** fill its two `.env` settings and restart. Nothing secret is
  entered in the connection form.
- **401 / 403:** check PAT expiry, app publication/scopes and document sharing. The interface
  shows the HTTP status or Feishu error code; server response bodies are not displayed.
- **429 / network / VPN failure:** retry sync after access is restored. An incomplete listing
  is not treated as an empty source. A completed Confluence listing reflects the account's
  current readable pages, so pages that cease to be visible are marked removed locally.
- **Reading paused:** check the model key, balance, local model download and the reading note.
  Reading resumes every 15 minutes. `config/gateway.trial.yaml` bounds daily reading and
  answer cost and pooled monthly cost; usage survives restart. The default cloud model is
  cleared only for public/internal documents.
- **Model download is slow:** the first import loads CPU models. The local model server's
  terminal output identifies download failures; retry after restoring access to Hugging Face.
- **Port occupied:** stop the earlier app, or set the port variables in `.env`. Keep database,
  Valkey and SpiceDB endpoints consistent when using a manually managed stack.

API references: [Confluence REST](https://developer.atlassian.com/server/confluence/rest/v900/),
[Feishu docx](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/guide),
[DeepSeek](https://api-docs.deepseek.com/en/).
