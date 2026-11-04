// The problem band's search box, inlined right after it. The page renders it answered. While
// it is in view, it plays the asking again and again: the question is sent, the five documents
// come up disagreeing, the answer arrives on top, and the documents are marked by what it
// found; it holds the answer, clears, and asks again. Off screen it waits at the question.
// Without script, or with reduced motion, it stays answered.

(() => {
  const STATES = ["is-asked", "is-results", "is-answer", "is-marked", "is-leaving"];
  /** When, within a round, each state is added; the round then starts over. */
  const CUES: [number, string][] = [
    [250, "is-asked"],
    [700, "is-results"],
    [2300, "is-answer"],
    [3200, "is-marked"],
    [7000, "is-leaving"],
  ];
  const ROUND = 7500;

  const box = document.querySelector<HTMLElement>("#problem .palette");
  if (!box || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const palette = box;

  let timers: number[] = [];

  /** The opening frame: the question typed, nothing found yet. */
  function rewind(): void {
    for (const t of timers) window.clearTimeout(t);
    timers = [];
    palette.classList.remove(...STATES);
    palette.classList.add("is-live");
  }

  function round(): void {
    rewind();
    timers = [
      ...CUES.map(([at, state]) => window.setTimeout(() => palette.classList.add(state), at)),
      window.setTimeout(round, ROUND),
    ];
  }

  rewind();
  new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) rewind();
      else if (timers.length === 0) round();
    },
    { threshold: 0.4 },
  ).observe(palette);
})();
