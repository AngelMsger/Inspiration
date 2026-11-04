// The figure beside the headline, inlined right after it. Without script, or with reduced
// motion, it is a still drawing. Otherwise, while it is in view, one source at a time
// changes: its tile lights, a pulse runs down its wire to the hub, the fact it feeds is
// marked as checked, and the change carries on to the people and agents who read the topic.
// It stops after a few rounds, so the page comes to rest.

(() => {
  /** The order the sources take turns in, by feed index; code first, as the busiest. */
  const ORDER = [2, 0, 3, 1];
  const ROUNDS = 3;
  const EVERY = 3900;
  /** When, within a turn, each part of the change happens. */
  const AT = { wire: 450, fact: 1350, out: 1750, readers: 2400, done: 3400 };

  const fig = document.querySelector<HTMLElement>("#top .hero-fig");
  if (!fig || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const figure = fig;

  let turn = 0;
  let seen = false;
  let loop: number | undefined;
  let timers: number[] = [];

  function parts(feed: number): Element[] {
    return [...figure.querySelectorAll(`[data-feed="${feed}"]`)];
  }

  function change(feed: number): void {
    const [tile, wire, fact] = [".feed", ".flow", ".topic-fact"].map((sel) =>
      parts(feed).find((el) => el.matches(sel)),
    );
    const hub = figure.querySelector(".hub");
    const outs = [...figure.querySelectorAll(".flow.out")];
    const readers = [...figure.querySelectorAll(".reader")];
    tile?.classList.add("is-live");
    timers.push(
      window.setTimeout(() => wire?.classList.add("is-flow"), AT.wire),
      window.setTimeout(() => {
        hub?.classList.add("is-hit");
        fact?.classList.add("is-hit");
      }, AT.fact),
      window.setTimeout(() => {
        for (const el of outs) el.classList.add("is-flow");
      }, AT.out),
      window.setTimeout(() => {
        for (const el of readers) el.classList.add("is-hit");
      }, AT.readers),
      window.setTimeout(() => {
        for (const el of [tile, wire, fact, hub, ...outs, ...readers])
          el?.classList.remove("is-live", "is-flow", "is-hit");
      }, AT.done),
    );
  }

  function next(): void {
    if (turn >= ORDER.length * ROUNDS) {
      stop();
      return;
    }
    change(ORDER[turn % ORDER.length] ?? 0);
    turn += 1;
  }

  function start(): void {
    if (!seen || loop !== undefined || turn >= ORDER.length * ROUNDS) return;
    next();
    loop = window.setInterval(next, EVERY);
  }

  function stop(): void {
    window.clearInterval(loop);
    loop = undefined;
    for (const t of timers) window.clearTimeout(t);
    timers = [];
    for (const el of figure.querySelectorAll(".is-live, .is-flow, .is-hit")) {
      el.classList.remove("is-live", "is-flow", "is-hit");
    }
  }

  new IntersectionObserver(
    (entries) => {
      seen = entries.some((e) => e.isIntersecting);
      // A short pause first, so the page is read before anything moves.
      if (seen) window.setTimeout(start, 900);
      else stop();
    },
    { threshold: 0.6 },
  ).observe(figure);
})();
