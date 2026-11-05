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
  nav: {
    how: string;
    sources: string;
    features: string;
    results: string;
    agents: string;
    language: string;
    github: string;
  };
  hero: {
    title: TitleRun[];
    lead: string;
    primary: string;
    /** The figure beside the headline: four kinds of source feed one topic, which answers people and agents. */
    figure: {
      label: string;
      /** In the order of SOURCE_KINDS; `event` shows while that source changes. */
      feeds: { kind: string; place: string; event: string }[];
      topic: string;
      topicMeta: string;
      /** One fact per feed, in the same order. */
      facts: { label: string; value: string }[];
      status: string;
      /** Who reads the topic, people then agents, and what each is given. */
      readers: { label: string; place: string; says: string }[];
    };
  };
  problem: {
    kicker: string;
    title: string;
    lead: string;
    /** What the animated search box shows, for screen readers. */
    label: string;
    /** `old`: the notice replaced this value; `source`: the notice itself. */
    documents: { name: string; place: string; value: string; mark: "old" | "source" | "" }[];
    answerLabel: string;
    answer: string;
    why: string;
    docsLabel: string;
    /** Above the documents while they disagree, then once the answer has marked them. */
    conflict: string;
    settled: string;
  };
  demo: {
    kicker: string;
    title: string;
    label: string;
    steps: { title: string; text: string }[];
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
  /** Measured results: one item per entry of RESULTS, in that order. */
  results: {
    kicker: string;
    title: string;
    lead: string;
    /** A figure, with its unit set smaller after it where it has one. */
    items: { value: string; unit: string; label: string; bars: string[]; foot: string }[];
    /** How a count of right answers reads, with {value} and {of}; and an amount in yuan, with {value}. */
    right: string;
    money: string;
    why: string;
    source: string;
    note: string;
    method: string;
    /** The method's document in the repository, in this language where it has a copy. */
    methodPath: string;
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
    /** A small picture of each kind of source as it looks where it lives. */
    samples: {
      document: { title: string; line: string; value: string };
      approval: { title: string; trips: string[]; manager: string; finance: string; rule: string };
      code: { change: string };
      research: { title: string; value: string; basis: string; due: string };
    };
    upkeep: string;
  };
  enterprise: { kicker: string; title: string; items: { title: string; text: string }[] };
  /** The page's last words; the only place that says the product is still being built. */
  closing: { title: string; note: string };
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
  scripts: { hero: string; ask: string; demo: string; menu: string };
  /** Leave out the document shell, for hosts that add their own (the Artifact preview). */
  fragment: boolean;
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
/** Pack text, with `**…**` around the words a reader should not miss. */
const rich = (s: string): string => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

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
  person: '<circle cx="10" cy="6.8" r="3.3"/><path d="M3.8 17.2c.9-3.4 3.3-5.3 6.2-5.3s5.3 1.9 6.2 5.3"/>',
  agent: '<rect x="3.5" y="6" width="13" height="10.5" rx="3"/><path d="M10 3v3M7.6 11.2h0M12.4 11.2h0"/>',
  merge:
    '<circle cx="6" cy="4.5" r="1.8"/><circle cx="6" cy="15.5" r="1.8"/><circle cx="14" cy="10" r="1.8"/><path d="M6 6.3v7.4M6 6.5c0 2.6 2.4 3.5 6.2 3.5"/>',
  key: '<circle cx="6.8" cy="10" r="3.4"/><path d="M10.2 10h7M14.6 10v3M17.2 10v2.4"/>',
  lock: '<rect x="4.5" y="9" width="11" height="8" rx="2"/><path d="M7 9V6.6a3 3 0 0 1 6 0V9"/>',
  shield:
    '<path d="M10 2.8 4.2 5v4.5c0 3.6 2.5 6.2 5.8 7.6 3.3-1.4 5.8-4 5.8-7.6V5z"/><path d="m7.5 10 1.8 1.8 3.3-3.5"/>',
  cloud: '<path d="M6.2 15.5h8a3.3 3.3 0 0 0 .4-6.6 4.7 4.7 0 0 0-9 .9 2.9 2.9 0 0 0 .6 5.7z"/>',
  globe:
    '<circle cx="10" cy="10" r="7.2"/><path d="M2.8 10h14.4M10 2.8c1.9 2 2.9 4.4 2.9 7.2s-1 5.2-2.9 7.2c-1.9-2-2.9-4.4-2.9-7.2s1-5.2 2.9-7.2z"/>',
  chevron: '<path d="m6 8 4 4 4-4"/>',
  check: '<path d="m5 10.4 3.3 3.3L15.2 7"/>',
};
const icon = (name: keyof typeof ICONS, size: number, cls: string): string =>
  `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

/** Where the source code lives; linked from the header and the footer. */
const REPOSITORY = "https://github.com/AngelMsger/Inspiration";
/** GitHub's mark (Octicons, MIT licence), filled rather than stroked like the other icons. */
const GITHUB_MARK =
  '<svg class="gh-mark" width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>';

/** Where each footnote number in the headline points: the section that shows the claim. */
const NOTE_TARGETS = ["#problem", "#how"];

/** A section's opening, centred so every band keeps the same axis. */
function head(kicker: string, title: string, lead = ""): string {
  return `<div class="sec-head"><p class="kicker">${esc(kicker)}</p><h2>${esc(title)}</h2>${lead ? `<p class="body">${rich(lead)}</p>` : ""}</div>`;
}

/** A line whose last word keeps the citation number with it. */
function cited(text: string): string {
  const cut = text.lastIndexOf(" ") + 1;
  return `${esc(text.slice(0, cut))}<span class="nowrap">${esc(text.slice(cut))}<span class="cite">1</span></span>`;
}

/** The kinds of source the hero figure and the sources section show, in their order. */
const SOURCE_KINDS = ["document", "approval", "code", "research"] as const;

function header(c: PageContext): string {
  const p = c.pack;
  // A menu rather than a row of names, so the header holds however many languages there are.
  const langs = c.packs
    .map(({ tag, pack }) =>
      tag === c.tag
        ? `<li><a href="${c.href(tag)}" aria-current="page" lang="${pack.meta.htmlLang}">${esc(pack.meta.name)}${icon("check", 16, "lang-check")}</a></li>`
        : `<li><a href="${c.href(tag)}" hreflang="${pack.meta.htmlLang}" lang="${pack.meta.htmlLang}">${esc(pack.meta.name)}</a></li>`,
    )
    .join("");
  return `<header class="top">
  <div class="wrap top-row">
    <a class="wordmark" href="#top">Inspiration</a>
    <nav class="top-nav" aria-label="Inspiration">
      <a href="#how">${esc(p.nav.how)}</a>
      <a href="#sources">${esc(p.nav.sources)}</a>
      <a href="#features">${esc(p.nav.features)}</a>
      <a href="#results">${esc(p.nav.results)}</a>
      <a href="#agents">${esc(p.nav.agents)}</a>
    </nav>
    <div class="top-tools">
      <a class="gh" href="${REPOSITORY}" aria-label="${esc(p.nav.github)}" title="${esc(p.nav.github)}">${GITHUB_MARK}<span>GitHub</span></a>
      <details class="lang-menu">
        <summary aria-label="${esc(`${p.nav.language}: ${p.meta.name}`)}">${icon("globe", 17, "lang-globe")}<span>${esc(p.meta.name)}</span>${icon("chevron", 14, "lang-chevron")}</summary>
        <ul>${langs}</ul>
      </details>
      <script>${c.scripts.menu}</script>
    </div>
  </div>
</header>`;
}

function hero(c: PageContext): string {
  const h = c.pack.hero;
  const title = h.title
    .map(
      (run) =>
        `<span class="run">${esc(run.text)}${sup(run.note, at(NOTE_TARGETS, run.note - 1, "hero.title.note"))}</span>`,
    )
    .join("");
  return `<section class="hero" id="top">
  <div class="wrap hero-grid">
    <div class="hero-copy">
      <h1>${title}</h1>
      <p class="lead">${rich(h.lead)}</p>
      <div class="actions"><a class="button" href="#how">${esc(h.primary)}</a></div>
    </div>
    ${heroFigure(c)}
  </div>
  <script>${c.scripts.hero}</script>
</section>`;
}

/**
 * Four kinds of source feed one topic, each fact marked with the kind it came from, and the
 * topic answers people and agents. Wires run from the middle of each quarter of the row of
 * feeds to the hub, and from the topic to the middle of each half of the row of readers, so
 * the drawing holds at any width; the script sends a change through one source at a time.
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
  const out = [100, 300]
    .map((x, i) => {
      const d = `M200 0C200 26 ${x} 22 ${x} 44`;
      return `<path class="wire" d="${d}"/><path class="flow out" data-reader="${i}" d="${d}" pathLength="1"/>`;
    })
    .join("");
  // People are given a cited answer, agents the same fact as data.
  const readers = f.readers
    .map(
      (r, i) =>
        `<li class="reader" data-reader="${i}"><span class="reader-head">${icon(i === 0 ? "person" : "agent", 15, "reader-ico")}<span class="reader-label">${esc(r.label)}</span><span class="reader-place">${esc(r.place)}</span></span>${i === 0 ? `<span class="reader-says">${cited(r.says)}</span>` : `<code class="reader-says">${esc(r.says)}</code>`}</li>`,
    )
    .join("");
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
      <svg class="wires wires-out" viewBox="0 0 400 44" preserveAspectRatio="none" aria-hidden="true">${out}</svg>
      <ul class="readers">${readers}</ul>
    </figure>`;
}

/**
 * The problem, as the product shows it: its search box, asked a question five documents answer
 * differently. It lists them, answers on top with the source it trusts, and marks the rest.
 * The answered frame is the default; the script plays the asking while the box is in view.
 */
function problem(c: PageContext): string {
  const p = c.pack.problem;
  const u = c.pack.demo.ui;
  const rows = p.documents
    .map((d, i) => {
      const mark =
        d.mark === "old"
          ? `<span class="pill old mark">${esc(u.outdated)}</span>`
          : d.mark === "source"
            ? '<span class="cite mark">1</span>'
            : "";
      return `<li class="pal-doc${d.mark === "old" ? " is-old" : ""}" style="--i:${i}">${icon("document", 16, "pal-ico")}<span class="pal-doc-name">${esc(d.name)}<span class="pal-doc-place">${esc(d.place)}</span></span><span class="v">${esc(d.value)}</span><span class="pal-doc-mark">${mark}</span></li>`;
    })
    .join("");
  const bars = (widths: number[]) => widths.map((w) => `<i style="width:${w}%"></i>`).join("");
  return `<section class="problem" id="problem">
  <div class="wrap">
    ${head(p.kicker, p.title, p.lead)}
    <div class="ask-stage">
      <div class="ask-app" aria-hidden="true">
        <div class="ask-app-top"><span>Inspiration</span><span class="ask-app-co">${esc(u.company)}</span></div>
        <div class="ask-app-body"><div>${bars([70, 52, 64, 46, 58])}</div><div>${bars([90, 76, 84, 40, 88, 66])}</div></div>
      </div>
      <div class="palette" role="img" aria-label="${esc(p.label)}">
        <div class="pal-input">${icon("research", 18, "pal-search")}<span class="pal-q">${esc(u.question)}</span><kbd class="pal-enter">⏎</kbd></div>
        <div class="pal-answer">
          <span class="pal-wait" aria-hidden="true"><i></i><i></i></span>
          <div class="pal-said">
            <p class="pal-label">${esc(p.answerLabel)}</p>
            <p class="pal-a">${cited(p.answer)}</p>
            <p class="pal-why">${esc(p.why)}</p>
          </div>
        </div>
        <div class="pal-docs">
          <p class="pal-head"><span class="pal-label">${esc(p.docsLabel)} · ${p.documents.length}</span><span class="pal-state"><span class="pal-conflict">${esc(p.conflict)}</span><span class="pal-settled">${esc(p.settled)}</span></span></p>
          <ul>${rows}</ul>
        </div>
      </div>
    </div>
  </div>
  <script>${c.scripts.ask}</script>
</section>`;
}

/** The scripted demo: an Inspiration window with the ask screen, a change notice and a todo. */
function stage(c: PageContext): string {
  const u = c.pack.demo.ui;
  const orig = u.original ? `<span class="orig">${esc(u.original)}</span>` : "";
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
            <p class="answer-line">${esc(u.answerBefore)}<span class="value">6<span class="roll"><span class="roll-col"><span>0</span><span>5</span></span></span>0</span>${cited(u.answerAfter)}</p>
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
        `<li data-step="${i + 1}"><span class="step-n">${i + 1}</span><span><strong class="step-title">${esc(s.title)}</strong><span class="step-text">${rich(s.text)}</span></span></li>`,
    )
    .join("");
  return `<section class="how" id="how">
  <div class="wrap">
    ${head(d.kicker, d.title)}
    <div class="demo">
      <div class="demo-copy">
        <ol class="steps">${steps}</ol>
        <p class="demo-foot">${esc(d.caption)}</p>
      </div>
      ${stage(c)}
    </div>
  </div>
  <script>${c.scripts.demo}</script>
</section>`;
}

/** The spread of hotel prices behind the research figure; the fourth bar holds the average. */
const SPREAD = [28, 46, 72, 100, 84, 52, 30];

/** Which trips in the approvals sample went past five days and so needed Finance as well. */
const FINANCE_SIGNED = [true, false, true];

/**
 * Each kind of source as it looks where it lives, holding one of the topic's facts: the wiki
 * page with its edited line, the approvals the rule was read from, the merged change to the
 * code, and the research figure with the date it is checked again.
 */
function sample(c: PageContext, kind: (typeof SOURCE_KINDS)[number]): string {
  const s = c.pack.sources.samples;
  const event = (i: number) => esc(at(c.pack.hero.figure.feeds, i, "hero.figure.feeds").event);
  const bar = (w: number) => `<i class="smp-bar" style="width:${w}%"></i>`;
  switch (kind) {
    case "document":
      return `<div class="smp smp-doc"><p class="smp-title">${esc(s.document.title)}<span class="smp-tag">${event(0)}</span></p>${bar(88)}${bar(64)}<p class="smp-line">${esc(s.document.line)} <mark>${esc(s.document.value)}</mark></p>${bar(80)}${bar(52)}</div>`;
    case "approval": {
      const trips = s.approval.trips
        .map(
          (t, i) =>
            `<li><span>${esc(t)}</span><span class="smp-steps"><span class="smp-step">${esc(s.approval.manager)}</span>${FINANCE_SIGNED[i] ? `<span class="smp-step">${esc(s.approval.finance)}</span>` : ""}</span></li>`,
        )
        .join("");
      return `<div class="smp smp-flow"><p class="smp-title">${esc(s.approval.title)}</p><ul>${trips}</ul><p class="smp-rule">${esc(s.approval.rule)}</p></div>`;
    }
    case "code":
      return `<div class="smp smp-code"><p class="smp-file">expense/limits.ts</p><div class="smp-diff"><span class="smp-ln del">-  tier1: 600,</span><span class="smp-ln add">+  tier1: 650,</span><span class="smp-ln">   tier2: 450,</span></div><p class="smp-pr">${icon("merge", 14, "smp-merge")}<span>${esc(s.code.change)}</span><span class="smp-tag">${event(2)}</span></p></div>`;
    case "research":
      return `<div class="smp smp-research"><p class="smp-title">${esc(s.research.title)}</p><p class="smp-value">${esc(s.research.value)}</p><p class="smp-basis">${esc(s.research.basis)}</p><span class="smp-spread" aria-hidden="true">${SPREAD.map((h, i) => `<i style="height:${h}%"${i === 3 ? ' class="on"' : ""}></i>`).join("")}</span><p class="smp-due">${icon("refresh", 13, "smp-due-ico")}${esc(s.research.due)}</p></div>`;
  }
}

function sources(c: PageContext): string {
  const s = c.pack.sources;
  const items = SOURCE_KINDS.map((kind, i) => {
    const it = at(s.items, i, "sources.items");
    return `<li class="kind">${sample(c, kind)}<h3>${icon(kind, 18, "kind-glyph")}${esc(it.title)}</h3><p>${rich(it.text)}</p><p class="kind-fresh">${icon("refresh", 16, "fresh-ico")}<span>${rich(it.fresh)}</span></p></li>`;
  }).join("");
  return `<section class="origins" id="sources">
  <div class="wrap">
    ${head(s.kicker, s.title, s.lead)}
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
        `<article class="card">${at(art, i, "features.items")}<h3>${esc(it.title)}</h3><p>${rich(it.text)}</p></article>`,
    )
    .join("");
  return `<section class="features" id="features">
  <div class="wrap">
    ${head(f.kicker, f.title)}
    <div class="cards">${cards}</div>
  </div>
</section>`;
}

/**
 * The bars beside each result, from docs/design/validation.md; the first of each pair is
 * Inspiration's. Right answers on the 204 changed or conflicting questions of the decisive test
 * after the governance fix (2026-11-04); right answers on its 27 changes announced in another
 * document, against the same documents read without governance; and the model cost of an
 * answer in yuan, measured on 2026-11-03.
 */
const RESULTS: { format: "right" | "money"; bars: [number, number]; of: number }[] = [
  { format: "right", bars: [178, 164], of: 204 },
  { format: "right", bars: [27, 16], of: 27 },
  { format: "money", bars: [0.0012, 0.0083], of: 0.0083 },
];

/** Where the mechanism behind the results is shown; cited as the preprint it is. */
const PAPER = "https://arxiv.org/abs/2611.04169v1";

function results(c: PageContext): string {
  const r = c.pack.results;
  const amount = (format: "right" | "money", value: number, of: number) =>
    format === "right"
      ? r.right.replace("{value}", String(value)).replace("{of}", String(of))
      : r.money.replace("{value}", String(value));
  const tiles = RESULTS.map((res, i) => {
    const it = at(r.items, i, "results.items");
    const bars = res.bars
      .map(
        (v, j) =>
          `<div class="res-bar${j === 0 ? " ours" : ""}"><p class="res-bar-h"><span>${esc(at(it.bars, j, "results.items.bars"))}</span><span class="res-num">${esc(amount(res.format, v, res.of))}</span></p><span class="res-track" aria-hidden="true"><i style="width:${((v / res.of) * 100).toFixed(1)}%"></i></span></div>`,
      )
      .join("");
    return `<li class="result"><p class="res-value">${esc(it.value)}${it.unit ? ` <span class="res-unit">${esc(it.unit)}</span>` : ""}</p><p class="res-label">${esc(it.label)}</p><div class="res-bars">${bars}</div><p class="res-foot">${esc(it.foot)}</p></li>`;
  }).join("");
  return `<section class="results" id="results">
  <div class="wrap">
    ${head(r.kicker, r.title, r.lead)}
    <ul class="result-row">${tiles}</ul>
    <div class="res-more">
      <p class="res-why">${rich(r.why)} <a class="res-link" href="${PAPER}">${esc(r.source)}</a></p>
      <p class="res-note">${esc(r.note)} <a class="res-link" href="${REPOSITORY}/blob/main/${esc(r.methodPath)}">${esc(r.method)}</a></p>
    </div>
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
    `<span class="tk-f">ask</span>({ ${k("question")}: ${s(a.question)} })`,
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
  <div class="wrap">
    ${head(a.kicker, a.title, a.lead)}
    <div class="agents-row">
    <ul class="points">${a.points.map((p) => `<li>${rich(p)}</li>`).join("")}</ul>
    <figure class="code">
      <pre><code>${code}</code></pre>
      <figcaption>${esc(a.note)}</figcaption>
    </figure>
    </div>
  </div>
</section>`;
}

/** One mark for each of the enterprise items, in their order. */
const ENTERPRISE_ICONS = ["key", "lock", "shield", "cloud"] as const;

function enterprise(c: PageContext): string {
  const e = c.pack.enterprise;
  const close = c.pack.closing;
  const items = e.items
    .map(
      (it, i) =>
        `<li><span class="ent-ico">${icon(at([...ENTERPRISE_ICONS], i, "enterprise.items"), 20, "ent-glyph")}</span><h3>${esc(it.title)}</h3><p>${rich(it.text)}</p></li>`,
    )
    .join("");
  return `<section class="enterprise" id="enterprise">
  <div class="wrap">
    ${head(e.kicker, e.title)}
    <ul class="grid4">${items}</ul>
    <div class="closing">
      <p class="closing-title">${esc(close.title)}</p>
      <p class="closing-note">${esc(close.note)}</p>
    </div>
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
    <a class="foot-gh" href="${REPOSITORY}">${GITHUB_MARK}GitHub</a>
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
<link rel="stylesheet" href="${esc(fonts)}" media="print" onload="this.media='all'">
<noscript><link rel="stylesheet" href="${esc(fonts)}"></noscript>
<style>${c.css}</style>`;
  const body = `<div class="site" lang="${m.htmlLang}" style="${esc(`--serif:${m.serif};--sans:${m.sans}`)}">
${header(c)}
<main>
${hero(c)}
${problem(c)}
${how(c)}
${sources(c)}
${features(c)}
${results(c)}
${agents(c)}
${enterprise(c)}
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
