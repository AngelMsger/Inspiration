# PageSpec and views

Pages are data, not HTML. The page compiler builds a `PageSpec`: an ordered list of typed blocks whose
sentences cite claims. The knowledge store keeps every rendered version as an immutable `PageSnapshot`.
The UI, exports, agents and diffing all read the same structure. This is how Inspiration
gets close to what Claude Artifacts can show while keeping every statement traceable and
every reader's permissions intact.

## Matching Claude Artifacts

| Artifact capability | Inspiration | Notes |
| --- | --- | --- |
| Markdown document | `heading`, `paragraph`, `list`, `quote`, `callout`, `table`, `code`, `math`, `divider` | Text is a list of `Sentence`s, each with `claim_ids`. Readers who cannot see a claim do not see its sentence. |
| Images and SVG | `image` | A blob reference with alt text and a caption. No inline scripts. |
| Mermaid and other diagrams | `diagram` | `DiagramSpec` in `mermaid`, `echarts` or `graph` format. A `DiagramCompiler` plugin builds it from structure (an SOP, an entity neighbourhood, a timeline); the model may pick what to show but never draws edges itself. |
| Charts | `chart` | `ChartSpec` with a `DataRef`. Data comes inline, from claims (fixed or by query, refreshed on rebuild, on a schedule or on view) or from a registered query of a connected system. Rows keep their claim IDs, so rows a reader may not see are dropped before rendering. |
| Interactive HTML or React | `view` | A sandboxed `ViewSpec` (below). Every view block has a static `fallback` block shown until the view is approved, to readers without JavaScript, and in exports. |
| Reusing content | `embed` | Transcludes another unit (an SOP, an entity card, a knowledge model) by reference, so it stays current. |
| Calling Claude from an artifact | `insp.ask` | A view may ask a question. The host answers it with retrieval's grounded answer, using the reader's permissions, and replies with `insp.answer`. |
| Downloading a file | `insp.download` | The view hands the host a file it built (CSV, image); the host offers it to the reader. |
| Persistent storage | Not offered | Views are stateless. Comments go through `insp.comment` into collaboration, so they are reviewed like any other comment. |
| Network access | Never | Views get data only through the host. |

## Views

A view is one approved version of one piece of interactive code:

- **Template or code.** A `ViewTemplate` is a reusable bundle shipped with the product (an
  SOP step navigator, a decision tree, a comparison matrix), configured per use. A view
  can also be generated or hand-written code. Both are a single HTML file with inline CSS
  and JavaScript.
- **Code and data are separate.** The `ViewSpec` holds code and a `data_schema`. The page's
  `view` block holds a `DataRef`. At serve time the host resolves the data with the knowledge store, drops
  rows the reader may not see, validates the rest against `data_schema`, and sends it with
  `insp.data`. The same approved code serves every reader.
- **Approval.** A new view version starts as `draft`. A headless render check
  (`RenderReport`: console errors, blocked requests, screenshots at several widths) moves
  it to `checked`. A person with verify rights on the space approves it. Only approved
  versions are served; until then readers see the fallback.
- **Sandbox.** Views run in an iframe served from a separate domain, with
  `sandbox="allow-scripts"` (no same-origin), a Content Security Policy that blocks every
  network request, and no access to cookies or storage of the main site.
- **Messages.** The host and the view speak only the typed protocol in `page.yaml`:
  host to view `insp.init`, `insp.data`, `insp.theme`, `insp.answer`; view to host
  `insp.ready`, `insp.resize`, `insp.navigate`, `insp.ask`, `insp.comment`,
  `insp.download`, `insp.error`. A view may use only the capabilities its spec declares.

## Versions and diffs

Each render that changes content writes a new version with its `SnapshotCause` (a source
change, an accepted proposal, a prompt or model upgrade, a restore). Block keys are stable
across versions, so `PageDiff` can say which blocks were added, removed, modified or moved,
and comments anchored to a block survive a rebuild. Restoring an old version writes a new
version whose blocks are pinned as overrides, so the next rebuild does not undo it.

The complete example in `packages/contracts/examples/PageSpec.travel-policy.json` uses every
block type and is validated by the contract tests.
