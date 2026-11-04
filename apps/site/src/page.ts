// The page, as one function of a language pack. Every word comes from the pack; this file
// holds only structure, so a language is added by adding a pack.

/** A line of the hero's headline, with the number of the footnote that follows it. */
export interface TitleRun {
  text: string;
  note: number;
}

/** Everything a language pack holds; `languages/<tag>.yaml` has exactly these keys. */
export interface Pack {
  meta: {
    name: string;
    htmlLang: string;
    serif: string;
    sans: string;
    fonts: string[];
    title: string;
    description: string;
  };
  nav: { how: string; sources: string; features: string; agents: string; language: string };
  hero: {
    status: string;
    title: TitleRun[];
    lead: string;
    primary: string;
    notes: string[];
    download: string;
    /** The figure beside the headline: four kinds of source feeding one topic. */
    figure: {
      label: string;
      /** In the order of SOURCE_KINDS; `event` shows while that source changes. */
      feeds: { kind: string; place: string; event: string }[];
      topic: string;
      topicMeta: string;
      /** One fact per feed, in the same order. */
      facts: { label: string; value: string }[];
      status: string;
    };
  };
  problem: {
    kicker: string;
    title: string;
    lead: string;
    /** `old`: the notice replaced this value; `source`: the notice itself. */
    documents: { name: string; place: string; value: string; mark: "old" | "source" | "" }[];
    answerLabel: string;
    answer: string;
    answerMeta: string;
  };
  demo: {
    kicker: string;
    title: string;
    label: string;
    steps: { title: string; text: string }[];
    replay: string;
    caption: string;
    ui: {
      company: string;
      search: string;
      question: string;
      answerBefore: string;
      answerAfter: string;
      note: string;
      original: string;
      policy: string;
      notice: string;
      outdated: string;
      changeLabel: string;
      changeMeta: string;
      inbox: string;
      owner: string;
      todoTitle: string;
      option: string;
      suggested: string;
      reason: string;
      confirm: string;
      confirmed: string;
      confirmedBy: string;
    };
  };
  features: {
    kicker: string;
    title: string;
    items: { title: string; text: string }[];
    trace: { quote: string; gloss: string; source: string };
    fresh: { steps: string[]; places: string[] };
    govern: { heading: string; rows: { label: string; value: string }[]; action: string };
    language: { fact: string; holds: string; source: string };
  };
  agents: {
    kicker: string;
    title: string;
    lead: string;
    points: string[];
    note: string;
    question: string;
    answer: string;
  };
  /** Where knowledge comes from: one item per entry of SOURCE_KINDS, in that order. */
  sources: {
    kicker: string;
    title: string;
    lead: string;
    items: { title: string; text: string; fresh: string }[];
    freshLabel: string;
    upkeep: string;
  };
  enterprise: { kicker: string; title: string; items: { title: string; text: string }[] };
  access: { kicker: string; title: string; text: string };
  footer: { line: string };
}

/** What a page needs besides its own pack. */
export interface PageContext {
  tag: string;
  pack: Pack;
  /** Every pack, in the order the language switch shows them. */
  packs: { tag: string; pack: Pack }[];
  /** The link from this page to the page of each language tag. */
  href: (tag: string) => string;
  css: string;
  /** Browser scripts, inlined after the part they drive. */
  scripts: { hero: string; demo: string };
  /** Leave out the document shell, for hosts that add their own (the Artifact preview). */
  fragment: boolean;
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

/** The language of the source documents in the story; their titles and quotes stay in it. */
const SOURCE_LANG = "zh-CN";

/** The entry a pack must have at this index, or a RangeError naming the key. */
function at<T>(list: T[], i: number, key: string): T {
  const item = list[i];
  if (item === undefined) throw new RangeError(`language pack: ${key}[${i}] is missing`);
  return item;
}

const sup = (n: number, href?: string): string =>
  href ? `<a class="cite" href="${href}">${n}</a>` : `<span class="cite">${n}</span>`;

/** Line icons on a 20-unit grid, drawn with the current colour. */
const ICONS = {
  document: '<path d="M5 2.5h6.5L15 6v11.5H5z"/><path d="M11.5 2.5V6H15M7.5 10h5M7.5 13h5"/>',
  approval: '<rect x="3" y="3" width="14" height="14" rx="3.5"/><path d="m6.6 10.2 2.3 2.3 4.5-4.9"/>',
  code: '<path d="M7 6 3 10l4 4M13 6l4 4-4 4M11.2 4.5l-2.4 11"/>',
  research: '<circle cx="8.8" cy="8.8" r="5.3"/><path d="m12.7 12.7 4.3 4.3"/>',
  refresh: '<path d="M16 10a6 6 0 1 1-1.76-4.24M16 3.6v3.3h-3.3"/>',
};
const icon = (name: keyof typeof ICONS, size: number, cls: string): string =>
  `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

/** The kinds of source the hero figure and the sources section show, in their order. */
const SOURCE_KINDS = ["document", "approval", "code", "research"] as const;

function header(c: PageContext): string {
  const p = c.pack;
  const langs = c.packs
    .map(({ tag, pack }) =>
      tag === c.tag
        ? `<a aria-current="true" lang="${pack.meta.htmlLang}">${esc(pack.meta.name)}</a>`
        : `<a href="${c.href(tag)}" hreflang="${pack.meta.htmlLang}" lang="${pack.meta.htmlLang}">${esc(pack.meta.name)}</a>`,
    )
    .join("");
  return `<header class="top">
  <div class="wrap top-row">
    <a class="wordmark" href="#top">Inspiration</a>
    <nav class="top-nav" aria-label="Inspiration">
      <a href="#how">${esc(p.nav.how)}</a>
      <a href="#sources">${esc(p.nav.sources)}</a>
      <a href="#features">${esc(p.nav.features)}</a>
      <a href="#agents">${esc(p.nav.agents)}</a>
    </nav>
    <nav class="langs" aria-label="${esc(p.nav.language)}">${langs}</nav>
  </div>
</header>`;
}

function hero(c: PageContext): string {
  const h = c.pack.hero;
  const title = h.title
    .map((run) => `<span class="run">${esc(run.text)}${sup(run.note, `#note-${run.note}`)}</span>`)
    .join("");
  const notes = h.notes.map((n, i) => `<li id="note-${i + 1}">${sup(i + 1)}<span>${esc(n)}</span></li>`).join("");
  return `<section class="hero" id="top">
  <div class="wrap hero-grid">
    <div class="hero-copy">
      <p class="status"><span class="dot" aria-hidden="true"></span>${esc(h.status)}</p>
      <h1>${title}</h1>
      <p class="lead">${esc(h.lead)}</p>
      <div class="actions">
        <a class="button" href="#how">${esc(h.primary)}</a>
        <span class="aside">${esc(h.download)}</span>
      </div>
    </div>
    ${heroFigure(c)}
    <ol class="notes">${notes}</ol>
  </div>
  <script>${c.scripts.hero}</script>
</section>`;
}

/**
 * Four kinds of source feeding one topic, each fact marked with the kind it came from. The
 * wires run from the middle of each quarter of the row of feeds to the hub, so the drawing
 * holds at any width; the script sends a change down one wire at a time.
 */
function heroFigure(c: PageContext): string {
  const f = c.pack.hero.figure;
  const feeds = SOURCE_KINDS.map((kind, i) => {
    const feed = at(f.feeds, i, "hero.figure.feeds");
    return `<li class="feed" data-feed="${i}"><span class="feed-event">${esc(feed.event)}</span><span class="feed-tile">${icon(kind, 20, "feed-ico")}<span class="feed-kind">${esc(feed.kind)}</span><span class="feed-place">${esc(feed.place)}</span></span></li>`;
  }).join("");
  const wires = SOURCE_KINDS.map((_, i) => {
    const x = 50 + i * 100;
    const d = `M${x} 0C${x} 34 200 26 200 60`;
    return `<path class="wire" d="${d}"/><path class="flow" data-feed="${i}" d="${d}" pathLength="1"/>`;
  }).join("");
  const facts = SOURCE_KINDS.map((kind, i) => {
    const fact = at(f.facts, i, "hero.figure.facts");
    return `<li class="topic-fact" data-feed="${i}">${icon(kind, 15, "topic-fact-ico")}<span class="topic-fact-label">${esc(fact.label)}</span><span class="topic-fact-value">${esc(fact.value)}</span></li>`;
  }).join("");
  return `<figure class="hero-fig" role="img" aria-label="${esc(f.label)}">
      <ul class="feeds">${feeds}</ul>
      <svg class="wires" viewBox="0 0 400 60" preserveAspectRatio="none" aria-hidden="true">${wires}</svg>
      <span class="hub" aria-hidden="true"></span>
      <div class="topic">
        <p class="topic-name">${esc(f.topic)}</p>
        <p class="topic-meta">${esc(f.topicMeta)}</p>
        <ul class="facts">${facts}</ul>
        <p class="topic-foot"><span class="dot" aria-hidden="true"></span>${esc(f.status)}</p>
      </div>
    </figure>`;
}

function problem(c: PageContext): string {
  const p = c.pack.problem;
  const outdated = c.pack.demo.ui.outdated;
  const rows = p.documents
    .map((d) => {
      const mark =
        d.mark === "old" ? `<span class="pill old">${esc(outdated)}</span>` : d.mark === "source" ? sup(1) : "";
      return `<li class="${d.mark === "old" ? "is-old" : ""}">
        <span class="doc"><span class="doc-name">${esc(d.name)}</span><span class="doc-place">${esc(d.place)}</span></span>
        <span class="doc-value"><span class="v">${esc(d.value)}</span>${mark}</span>
      </li>`;
    })
    .join("");
  return `<section class="problem" id="problem">
  <div class="wrap split">
    <div class="copy">
      <p class="kicker">${esc(p.kicker)}</p>
      <h2>${esc(p.title)}</h2>
      <p class="body">${esc(p.lead)}</p>
    </div>
    <div class="figure">
      <ul class="sheet docs">${rows}</ul>
      <div class="resolved">
        <p class="label">${esc(p.answerLabel)}</p>
        <p class="res-answer">${esc(p.answer)}${sup(1)}</p>
        <p class="meta">${esc(p.answerMeta)}</p>
      </div>
    </div>
  </div>
</section>`;
}

/** The scripted demo: an Inspiration window with the ask screen, a change notice and a todo. */
function stage(c: PageContext): string {
  const u = c.pack.demo.ui;
  const orig = u.original ? `<span class="orig">${esc(u.original)}</span>` : "";
  // The citation number stays on the line of the word it follows.
  const cut = u.answerAfter.lastIndexOf(" ") + 1;
  const after = `${esc(u.answerAfter.slice(0, cut))}<span class="nowrap">${esc(u.answerAfter.slice(cut))}<span class="cite">1</span></span>`;
  const bars = (widths: number[]) => widths.map((w) => `<i class="bar" style="width:${w}%"></i>`).join("");
  // The final frame is the default, so a page without script, or with reduced motion, shows
  // the result; the script rewinds it before it is seen and plays it once in view.
  return `<div class="stage-wrap">
  <div class="stage is-changed is-todo is-confirmed" data-layout="wide" role="img" aria-label="${esc(c.pack.demo.label)}">
    <div class="win">
      <div class="win-top">
        <span class="win-mark">Inspiration</span>
        <span class="win-company">${esc(u.company)}</span>
        <span class="win-search">${esc(u.search)}<kbd>⌘K</kbd></span>
        <span class="win-avatar" aria-hidden="true"></span>
      </div>
      <div class="win-body">
        <div class="win-nav">${bars([62, 48, 70])}<i class="gap"></i>${bars([40, 76, 58, 66, 52])}</div>
        <div class="win-main">
          <div class="ask"><span class="ask-q">${esc(u.question)}</span><kbd>⏎</kbd></div>
          <div class="st-answer">
            <p class="answer-line">${esc(u.answerBefore)}<span class="value">6<span class="roll"><span class="roll-col"><span>0</span><span>5</span></span></span>0</span>${after}</p>
            <div class="grow note"><div><p class="answer-note">${esc(u.note)}</p></div></div>
            <ol class="sources">
              <li class="grow src-new"><div><span class="src"><span class="cite">1</span><span class="src-title" lang="${SOURCE_LANG}">${esc(u.notice)}</span>${orig}</span></div></li>
              <li class="src-old"><span class="src"><span class="cite"><span class="roll"><span class="roll-col"><span>1</span><span>2</span></span></span></span><span class="src-title" lang="${SOURCE_LANG}">${esc(u.policy)}</span>${orig}<span class="pill old">${esc(u.outdated)}</span></span></li>
            </ol>
            <div class="grow confirmed-line"><div><p class="by"><span class="tick" aria-hidden="true"></span>${esc(u.confirmedBy)}</p></div></div>
          </div>
          <div class="filler">${bars([92, 84, 88, 60])}</div>
        </div>
      </div>
    </div>
    <div class="sat notice-card">
      <p class="sat-label"><span class="doc-ico" aria-hidden="true"></span>${esc(u.changeLabel)}</p>
      <p class="sat-title" lang="${SOURCE_LANG}">${esc(u.notice)}</p>
      <p class="sat-meta">${esc(u.changeMeta)}</p>
    </div>
    <div class="sat todo-card">
      <p class="sat-label">${esc(u.inbox)} · ${esc(u.owner)}</p>
      <p class="todo-title">${esc(u.todoTitle)}</p>
      <div class="option"><span class="radio" aria-hidden="true"></span><span>${esc(u.option)} <span class="suggested">${esc(u.suggested)}</span><span class="reason">${esc(u.reason)}</span></span></div>
      <span class="confirm" data-target="confirm"><span class="c-state c-idle">${esc(u.confirm)} <kbd>⏎</kbd></span><span class="c-state c-done"><span class="tick" aria-hidden="true"></span>${esc(u.confirmed)}</span></span>
    </div>
    <svg class="cursor" width="22" height="26" viewBox="0 0 22 26" aria-hidden="true"><path d="M2 1.5v19.2l5-4.6 3.3 7.6 3.3-1.4-3.2-7.4 6.9-.4z" fill="#1C1E23" stroke="#FBFAF7" stroke-width="1.5" stroke-linejoin="round"/></svg>
  </div>
</div>`;
}

function how(c: PageContext): string {
  const d = c.pack.demo;
  const steps = d.steps
    .map(
      (s, i) =>
        `<li data-step="${i + 1}"><span class="step-n">${i + 1}</span><span><strong>${esc(s.title)}</strong><span class="step-text">${esc(s.text)}</span></span></li>`,
    )
    .join("");
  return `<section class="how" id="how">
  <div class="wrap">
    <p class="kicker">${esc(d.kicker)}</p>
    <h2>${esc(d.title)}</h2>
    <div class="demo">
      <div class="demo-copy">
        <ol class="steps">${steps}</ol>
        <p class="demo-foot"><button type="button" class="replay" hidden><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2.5 7a4.5 4.5 0 1 0 1.4-3.3M2.5 1.5v2.6h2.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>${esc(d.replay)}</button><span>${esc(d.caption)}</span></p>
      </div>
      ${stage(c)}
    </div>
  </div>
  <script>${c.scripts.demo}</script>
</section>`;
}

function sources(c: PageContext): string {
  const s = c.pack.sources;
  const items = SOURCE_KINDS.map((kind, i) => {
    const it = at(s.items, i, "sources.items");
    return `<li class="kind"><span class="kind-ico">${icon(kind, 22, "kind-glyph")}</span><h3>${esc(it.title)}</h3><p>${esc(it.text)}</p><p class="kind-fresh">${icon("refresh", 16, "fresh-ico")}<span><strong>${esc(s.freshLabel)}</strong>${esc(it.fresh)}</span></p></li>`;
  }).join("");
  return `<section class="origins" id="sources">
  <div class="wrap">
    <p class="kicker">${esc(s.kicker)}</p>
    <h2>${esc(s.title)}</h2>
    <p class="body">${esc(s.lead)}</p>
    <ul class="kinds">${items}</ul>
    <p class="upkeep">${esc(s.upkeep)}</p>
  </div>
</section>`;
}

function features(c: PageContext): string {
  const f = c.pack.features;
  const u = c.pack.demo.ui;
  const trace = `<div class="ill trace">
    <p class="sentence">${esc(u.answerBefore)}650${esc(u.answerAfter)}<span class="cite on">1</span></p>
    <div class="pop">
      <p class="quote" lang="${SOURCE_LANG}">“${esc(f.trace.quote)}”</p>
      ${f.trace.gloss ? `<p class="gloss">${esc(f.trace.gloss)}</p>` : ""}
      <p class="src-line"><span lang="${SOURCE_LANG}">${esc(f.trace.source)}</span></p>
    </div>
  </div>`;
  const fresh = `<div class="ill fresh"><ol class="log">${f.fresh.steps
    .map((s, i) => `<li${i === f.fresh.steps.length - 1 ? ' class="last"' : ""}><span>${esc(s)}</span></li>`)
    .join("")}</ol><ul class="places">${f.fresh.places.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div>`;
  const govern = `<div class="ill govern"><div class="mini"><p class="mini-h">${esc(f.govern.heading)}</p><ul>${f.govern.rows
    .map((r) => `<li><span>${esc(r.label)}</span><span class="num">${esc(r.value)}</span></li>`)
    .join("")}</ul><span class="button small">${esc(f.govern.action)}</span></div></div>`;
  const asks = c.packs
    .map(
      ({ pack }) =>
        `<li lang="${pack.meta.htmlLang}"><span class="tag">${esc(pack.meta.name)}</span>${esc(pack.demo.ui.question)}</li>`,
    )
    .join("");
  const language = `<div class="ill lang"><ul class="asks">${asks}</ul><div class="fact"><p class="fact-v">${esc(f.language.fact)}</p><p class="fact-h">${esc(f.language.holds)}</p><p class="fact-s">${esc(f.language.source)}</p></div></div>`;
  const art = [trace, fresh, govern, language];
  const cards = f.items
    .map(
      (it, i) =>
        `<article class="card">${at(art, i, "features.items")}<h3>${esc(it.title)}</h3><p>${esc(it.text)}</p></article>`,
    )
    .join("");
  return `<section class="features" id="features">
  <div class="wrap">
    <p class="kicker">${esc(f.kicker)}</p>
    <h2>${esc(f.title)}</h2>
    <div class="cards">${cards}</div>
  </div>
</section>`;
}

function agents(c: PageContext): string {
  const a = c.pack.agents;
  const u = c.pack.demo.ui;
  const s = (v: string) => `<span class="tk-s">"${esc(v)}"</span>`;
  const k = (v: string) => `<span class="tk-k">${v}</span>`;
  const code = [
    `<span class="tk-c">// MCP · knowledge.read</span>`,
    `<span class="tk-f">ask</span>({`,
    `  ${k("question")}: ${s(a.question)},`,
    `  ${k("max_tokens")}: <span class="tk-n">400</span>`,
    `})`,
    ``,
    `<span class="tk-c">// →</span>`,
    `{`,
    `  ${k('"answer"')}: ${s(`${a.answer} [1]`)},`,
    `  ${k('"citations"')}: [{`,
    `    ${k('"source"')}: <span class="tk-s" lang="${SOURCE_LANG}">"${esc(u.notice)} · §2"</span>,`,
    `    ${k('"status"')}: ${s("fresh")},`,
    `    ${k('"holds_from"')}: ${s("2026-10-01")}`,
    `  }],`,
    `  ${k('"superseded"')}: [<span class="tk-s" lang="${SOURCE_LANG}">"${esc(u.policy)} · 600"</span>],`,
    `  ${k('"review"')}: ${s("confirmed")},`,
    `  ${k('"tokens"')}: <span class="tk-n">182</span>`,
    `}`,
  ].join("\n");
  return `<section class="agents" id="agents">
  <div class="wrap split">
    <div class="copy">
      <p class="kicker">${esc(a.kicker)}</p>
      <h2>${esc(a.title)}</h2>
      <p class="body">${esc(a.lead)}</p>
      <ul class="points">${a.points.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>
    </div>
    <figure class="code">
      <pre><code>${code}</code></pre>
      <figcaption>${esc(a.note)}</figcaption>
    </figure>
  </div>
</section>`;
}

function enterprise(c: PageContext): string {
  const e = c.pack.enterprise;
  return `<section class="enterprise">
  <div class="wrap">
    <p class="kicker">${esc(e.kicker)}</p>
    <h2>${esc(e.title)}</h2>
    <ul class="grid4">${e.items.map((it) => `<li><h3>${esc(it.title)}</h3><p>${esc(it.text)}</p></li>`).join("")}</ul>
  </div>
</section>`;
}

function access(c: PageContext): string {
  const a = c.pack.access;
  return `<section class="access" id="access">
  <div class="wrap">
    <p class="kicker">${esc(a.kicker)}</p>
    <h2>${esc(a.title)}</h2>
    <p class="body">${esc(a.text)}</p>
  </div>
</section>`;
}

function footer(c: PageContext): string {
  const langs = c.packs
    .map(({ tag, pack }) => `<a href="${c.href(tag)}" lang="${pack.meta.htmlLang}">${esc(pack.meta.name)}</a>`)
    .join("");
  return `<footer class="foot">
  <div class="wrap foot-row">
    <span class="wordmark">Inspiration</span>
    <p>${esc(c.pack.footer.line)}</p>
    <nav class="langs" aria-label="${esc(c.pack.nav.language)}">${langs}</nav>
  </div>
</footer>`;
}

const ICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#EFEEE9"/><text x="9" y="25" font-family="Georgia,serif" font-size="24" fill="#1C1E23">i</text><rect x="18" y="5" width="9" height="11" rx="2.5" fill="#2E3F8F"/><text x="20.2" y="13.6" font-family="Arial,sans-serif" font-size="8.5" font-weight="700" fill="#FBFAF7">1</text></svg>',
  );

export function renderPage(c: PageContext): string {
  const m = c.pack.meta;
  const fonts = `https://fonts.googleapis.com/css2?${m.fonts.map((f) => `family=${f.replace(/ /g, "+")}`).join("&")}&display=swap`;
  const head = `<title>${esc(m.title)}</title>
<meta name="description" content="${esc(m.description)}">
<meta property="og:title" content="${esc(m.title)}">
<meta property="og:description" content="${esc(m.description)}">
<meta property="og:type" content="website">
${c.packs.map(({ tag, pack }) => `<link rel="alternate" hreflang="${pack.meta.htmlLang}" href="${c.href(tag)}">`).join("\n")}
<link rel="icon" href="${ICON}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${esc(fonts)}">
<style>${c.css}</style>`;
  const body = `<div class="site" lang="${m.htmlLang}" style="${esc(`--serif:${m.serif};--sans:${m.sans}`)}">
${header(c)}
<main>
${hero(c)}
${problem(c)}
${how(c)}
${sources(c)}
${features(c)}
${agents(c)}
${enterprise(c)}
${access(c)}
</main>
${footer(c)}
</div>`;
  // A preview is named like a page in a gallery, not like a search result.
  if (c.fragment) {
    const meta = '<meta name="claude:viewport-fit-sides" content="cover">\n<title>Inspiration website</title>';
    return `${head.replace(/<title>.*<\/title>/, meta)}\n${body}\n`;
  }
  return `<!doctype html>
<html lang="${m.htmlLang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${head}
</head>
<body>
${body}
</body>
</html>
`;
}
