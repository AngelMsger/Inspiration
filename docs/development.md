# Development

How to build, test and run Inspiration from this repository: the stack, the checks, the
measurement harness and the demo. What the product is and where it is going is in the
[README](../README.md) and the [overview](overview.md); the rules for changing anything are in
[AGENTS.md](../AGENTS.md). A Chinese copy is in [zh/development.md](zh/development.md).

## Set up and check

You need Node 22.18 or later (Node 24 works too), pnpm, Python 3.10 or later, and Docker with
Compose. `package.json` pins pnpm 10.28.0 in `packageManager`, which corepack (`corepack enable`)
and any pnpm from 10 on follow, and pins Node 22 and pnpm 10.28.0 for Volta. That pin matters:
Volta starts pnpm through `bin/pnpm.cjs`, which pnpm 11 and later no longer ship, so a Volta pnpm
of 11 or later fails with `Cannot find module …/bin/pnpm.cjs` outside this repository, and works
inside it.

```bash
make install       # pnpm dependencies, and the parsing worker's Python libraries in .venv
make up            # ParadeDB (Postgres 16 + pgvector + pg_search), Valkey, SpiceDB
make migrate       # SQL migrations of every installed component
make authz-schema  # the SpiceDB schema
make check         # Biome, tsc, contract freshness, all tests with the stack required
```

Without make, the same steps are `pnpm install`, `python3 -m venv .venv && .venv/bin/pip install -r
engine/parsing/worker/requirements.txt`, `docker compose -f infra/compose.yaml up -d --wait`,
`pnpm exec inspiration-migrate`, `pnpm exec inspiration-authz-schema` and
`INSPIRATION_REQUIRE_STACK=1 pnpm test`.

Tests that need the stack skip when it is not running, unless `INSPIRATION_REQUIRE_STACK=1`
is set, as it is in CI. Each one gets its own database copied from a migrated template and
its own Valkey key prefix. `make test-unit` runs only the tests that need nothing.

Keys and passwords stay out of the repository. A config names the environment variable that
holds a key (`api_key_env`), and `.env` is ignored. CI's `secrets` job runs Gitleaks over every
commit of every branch, with its default rules and the shapes of the DeepSeek, OpenAI and
Anthropic keys (`.github/gitleaks.toml`), and fails on any finding, which it prints redacted.

Everything is TypeScript on Node 22 except the parsing worker, which is Python because the
best document parsers are. The engine sends it Word, PowerPoint, Excel and PDF files at
`INSPIRATION_PARSING_URL`; `pnpm parsing` starts it there, on port 8790. Without it, those
files fail to read and say the worker is not reachable; the other formats need nothing. [`components.yaml`](../components.yaml) lists every component with its
status (built, in progress or planned), and each package's `src/index.ts` says what it does.

## Run the engine over a corpus

To run the engine over a corpus and print what it produced, use the measurement harness:

```bash
pnpm bench ingest examples/corpus            # the demo tenant, in memory
pnpm bench ingest examples/corpus --stack    # on Postgres and Valkey from INSPIRATION_* settings
pnpm bench synthesize /tmp/synth --documents 2000 && pnpm bench ingest /tmp/synth --stack
pnpm bench replay examples/gitlab-expenses   # a real policy through 21 versions of its history
pnpm bench ask examples/kubernetes-docs "How many nodes can a Kubernetes cluster have at most?"
```

[`examples/README.md`](../examples/README.md) lists every corpus, what it measures, how to run
it and which test holds it to its answers. The runs on real models, with their costs and logs,
are in [`apps/bench/runs/`](../apps/bench/runs/README.md).

## Run the demo

To see the product, run the demo. It reads the demo tenant with the development models, so it
costs nothing, then serves the web app at http://127.0.0.1:5173. Sign in, which there signs
you in as 陈晨 with no password, and the account menu switches the person you act as and the
interface language. As 陈晨, ask how much a night in Shenzhen
may cost: the answer gives the hotel price list's 650 and says the travel policy still says
600. As 李娜, confirm 650 in the inbox, and the FAQ's and minutes' 600 reads as outdated. As
周敏, the finance space owner, put in edition 7 of the travel policy: within a second its
tier-1 row says 650:

```bash
pnpm demo                                          # the engine on port 4100, the web app on 5173
pnpm engine serve examples/corpus --dev-identity   # the engine's HTTP API alone, trusting identity headers
pnpm engine serve --issuer <business URL> --audience http://127.0.0.1:4100   # empty, for the business layer to provision
pnpm snapshot dist/snapshot                        # record the demo script as a static page
```

The demo script (`examples/corpus/script.yaml`) lists those steps, each with the person who
takes it. `pnpm snapshot` walks it against the engine and writes a static page that answers
from the recording, with a guide along the bottom that opens each step as its person, so anyone
can follow the demo from a link, without the engine. A question the script does not ask, or a
step it does not take, says it was not recorded. The page holds everything each person of the
demo tenant could read, for whoever opens it: acting as someone there is a simulation, not
access control. So record only the synthetic demo corpus, or a corpus whose whole contents
everyone who gets the link may read.

## Sign in for real

To sign in for real, with email and password, run Logto and the business backend in front of
the engine. Logto runs in the compose file under its own profile. Once, in its console at
http://localhost:3002, create a "Traditional web" application with the redirect URI
`http://localhost:4200/api/auth/callback` and the post sign-out redirect URI
`http://localhost:4200/`, and put its ID and secret in `.env` as `INSPIRATION_LOGTO_APP_ID` and
`INSPIRATION_LOGTO_APP_SECRET`, with `INSPIRATION_LOGTO_ISSUER=http://localhost:3001/oidc`.
`apps/business/src/serve.ts` lists the other settings.

```bash
docker compose -f infra/compose.yaml --profile auth up -d --wait   # make up, and Logto on 3001
pnpm --dir apps/web exec vite build                                 # the web app, into apps/web/dist
pnpm parsing                                                        # reads uploaded Word, PowerPoint, Excel and PDF
pnpm engine serve examples/corpus --issuer http://localhost:4200 --audience http://127.0.0.1:4100
pnpm business serve --web apps/web/dist --sample examples/corpus    # the site at http://localhost:4200
```

The demo corpus is the sample company here: anyone signed in can open it and read what its
whole company may, and nobody can change it. Leave the corpus out of both commands for an
engine with no documents. Either way the engine keeps everything in memory: companies and
members come from the business backend, and spaces are made in the web app. After restarting
the engine, restart the business backend too, which sends every company and member, and every
visitor of the sample company, to it again when it starts; spaces made before the restart are
gone.

## Try the model gateway

To try the model gateway without a model server, run it with the fake providers:

```bash
make gateway
curl -s localhost:8100/healthz
```

## Build the website

`pnpm site` writes the product website (`apps/site`) to `apps/site/dist`, one static page per
language; `pnpm site --serve` serves it and rebuilds on every request. The `Site` workflow
publishes it to GitHub Pages from `main`.

## Redraw the diagrams

The architecture diagrams in `docs/assets/` are drawn by `components.html` and `deployment.html`
beside them, one file per figure with its words in English, Chinese and Japanese. Open one in a
browser with `?lang=en`, `zh` or `ja` (and `&theme=dark` for the dark version), and screenshot the
`#fig` element at twice its size into `<figure>.<lang>.png` (or `<figure>.<lang>.dark.png`). When a component is built, take the `planned` flag off it there and redraw.

## Where things live

The [README's layout](../README.md#repository-layout) lists every top-level folder, and
[Architecture](architecture.md) explains the layers and how components talk. Business
components live in `business/`, next to `engine/` and `libs/` (see
[One repository, a folder per layer](architecture.md#one-repository-a-folder-per-layer)), and
are listed in the `business` section of `components.yaml`.
