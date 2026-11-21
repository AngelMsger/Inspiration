// Connect and reconcile online documents. Polling survives navigation and process restarts.
import type { ConnectionList, CreateConnection, Source } from "@inspiration/contracts";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { type ApiFailure, api, failureOf } from "./api.ts";
import { Failure, formatDate } from "./parts.tsx";
import { Link } from "./route.tsx";
import { useWords } from "./words.ts";

export function Sources(props: { space: string; kind?: CreateConnection["type"]; onChanged: () => void }) {
  const { say, tag } = useWords();
  const onChanged = useRef(props.onChanged);
  onChanged.current = props.onChanged;
  const completed = useRef("");
  const [data, setData] = useState<ConnectionList>();
  const [error, setError] = useState<ApiFailure>();
  const [loadError, setLoadError] = useState<ApiFailure>();
  const [busy, setBusy] = useState(false);
  const [pickedKind, setKind] = useState<CreateConnection["type"]>("confluence");
  const kind = props.kind ?? pickedKind;
  const [name, setName] = useState("");
  const [pageIds, setPageIds] = useState("");
  const [wholeSpace, setWholeSpace] = useState(false);
  const [targets, setTargets] = useState("");
  const [level, setLevel] = useState<CreateConnection["governance_level"]>("reference");
  const [refresh, setRefresh] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh requests an immediate reload after a sync starts
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const next = await api.connections(props.space);
        if (live) {
          setData(next);
          setLoadError(undefined);
          const finished = next.sources.map((s) => `${s.id}:${s.sync?.finished_at ?? ""}`).join("|");
          if (finished !== completed.current) {
            completed.current = finished;
            onChanged.current();
          }
          timer = setTimeout(load, 2000);
        }
      } catch (e) {
        if (live) {
          setLoadError(failureOf(e));
          timer = setTimeout(load, 5000);
        }
      }
    };
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [props.space, refresh]);

  const sync = async (source: Source) => {
    setBusy(true);
    setError(undefined);
    try {
      const started = await api.startSync(source.id);
      setData((old) => old && { ...old, sources: old.sources.map((s) => (s.id === source.id ? started : s)) });
      setRefresh((n) => n + 1);
      props.onChanged();
    } catch (e) {
      setError(failureOf(e));
    } finally {
      setBusy(false);
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const source = await api.connectSource(props.space, {
        type: kind,
        name: name.trim(),
        targets: [
          ...new Set(
            targets
              .split(/\r?\n/)
              .map((s) => s.trim())
              .filter(Boolean),
          ),
        ] as [string, ...string[]],
        ...(kind === "confluence" &&
          !wholeSpace && {
            page_ids: [...new Set(pageIds.split(/[\s,]+/).filter(Boolean))] as [string, ...string[]],
          }),
        governance_level: level,
      });
      setData((old) => old && { ...old, sources: [...old.sources, source] });
      setName("");
      setTargets("");
      setPageIds("");
      setWholeSpace(false);
      await sync(source);
    } catch (e) {
      setError(failureOf(e));
    } finally {
      setBusy(false);
    }
  };
  const configured = data?.configured[kind === "confluence" ? "confluence" : "feishu"];
  return (
    <>
      <p>{say("connections.lede")}</p>
      {!props.kind && <p className="quiet">{say("connections.access")}</p>}
      {error && <Failure error={error} />}
      {loadError && <Failure error={loadError} />}
      <form className="gate-form connection-form" onSubmit={submit}>
        {!props.kind && (
          <label>
            <span>{say("connections.kind")}</span>
            <select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as CreateConnection["type"]);
                setTargets("");
                setPageIds("");
                setWholeSpace(false);
              }}
            >
              <option value="confluence">{say("source.confluence")}</option>
              <option value="feishu.docx">{say("source.feishu.docx")}</option>
            </select>
          </label>
        )}
        {data && !configured && (
          <div className="gate-alert">
            <p>{say("connections.not_configured")}</p>
            <details>
              <summary>{say("connections.setup")}</summary>
              <p>{say(kind === "confluence" ? "connections.configure_confluence" : "connections.configure_feishu")}</p>
            </details>
          </div>
        )}
        <label>
          <span>{say("connections.name")}</span>
          <input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label htmlFor="connection-targets">
          <span>{say(kind === "confluence" ? "connections.space_key" : "connections.links")}</span>
          {kind === "confluence" ? (
            <input
              id="connection-targets"
              required
              pattern="[a-zA-Z0-9_~-]+"
              maxLength={2048}
              value={targets}
              onChange={(e) => setTargets(e.target.value)}
            />
          ) : (
            <textarea
              id="connection-targets"
              required
              rows={4}
              value={targets}
              onChange={(e) => setTargets(e.target.value)}
            />
          )}
          <span className="quiet">{say(kind === "confluence" ? "import.confluence_hint" : "import.feishu_hint")}</span>
        </label>
        {kind === "confluence" && (
          <>
            <label>
              <span>{say("connections.scope")}</span>
              <select
                value={wholeSpace ? "space" : "pages"}
                onChange={(e) => setWholeSpace(e.target.value === "space")}
              >
                <option value="pages">{say("connections.selected_pages")}</option>
                <option value="space">{say("connections.whole_space")}</option>
              </select>
            </label>
            {!wholeSpace && (
              <label>
                <span>{say("connections.page_ids")}</span>
                <textarea required rows={3} value={pageIds} onChange={(e) => setPageIds(e.target.value)} />
                <span className="quiet">{say("connections.page_ids_hint")}</span>
              </label>
            )}
          </>
        )}
        <label>
          <span>{say("connections.level")}</span>
          <select value={level} onChange={(e) => setLevel(e.target.value as CreateConnection["governance_level"])}>
            {(["reference", "governed", "search_only"] as const).map((l) => (
              <option value={l} key={l}>
                {say(`level.${l}`)}
              </option>
            ))}
          </select>
        </label>
        <p className="quiet">{say(`connections.${level}`)}</p>
        <button
          className="primary"
          type="submit"
          disabled={
            busy ||
            !configured ||
            !name.trim() ||
            !targets.trim() ||
            (kind === "confluence" && !wholeSpace && !pageIds.trim())
          }
        >
          {say(busy ? "connections.starting" : "connections.connect")}
        </button>
      </form>
      <h2>{say("connections.connected")}</h2>
      {!data && <p className="quiet">{say("space.loading")}</p>}
      {data?.sources.length === 0 && <p className="quiet">{say("connections.empty")}</p>}
      {data?.sources.map((source) => (
        <section className="connection-card" key={source.id}>
          <div className="heading">
            <h3>{source.name}</h3>
            <button
              type="button"
              className="secondary"
              disabled={busy || source.sync?.state === "running"}
              onClick={() => void sync(source)}
            >
              {say(source.sync?.state === "running" ? "connections.running" : "connections.sync")}
            </button>
          </div>
          <p className="quiet">
            {say(`source.${source.type}`)} · {say(`level.${source.governance_level ?? "reference"}`)}
          </p>
          <p className="quiet">{say("connections.scope")}</p>
          <p className="connection-targets">{source.scope.ids?.join("\n")}</p>
          {Array.isArray(source.scope.options?.page_ids) && (
            <p className="quiet">
              {say("connections.selected_pages")}: {source.scope.options.page_ids.join(", ")}
            </p>
          )}
          {source.type === "confluence" && !Array.isArray(source.scope.options?.page_ids) && (
            <p className="quiet">{say("connections.whole_space")}</p>
          )}
          {source.sync && (
            <div role="status">
              <b>{say(`connections.${source.sync.state}`)}</b>
              {source.sync.finished_at && <> · {formatDate(tag, source.sync.finished_at, true)}</>}
              {source.sync.report && <p>{say("connections.result", source.sync.report.outcomes)}</p>}
              {source.sync.note && <p className="failure">{source.sync.note}</p>}
              {source.sync.report?.errors.map((e) => (
                <p className="failure" key={e.external_id}>
                  {e.external_id}: {e.error}
                </p>
              ))}
            </div>
          )}
          <Link to={{ name: "documents", space: props.space, source: source.id, folders: [] }}>
            {say("connections.open")}
          </Link>
        </section>
      ))}
      <p className="quiet">{say("connections.processing")}</p>
    </>
  );
}
