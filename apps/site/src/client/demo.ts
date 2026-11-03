// The demo on the product website, inlined into each page right after its stage. It is a
// scripted illustration, not the product: it sets states on the stage, and the stylesheet
// animates between them. It plays once when half of it is in view, ends on the result and
// holds it; Replay plays it again. With reduced motion, or without script, the page keeps the
// final frame it was rendered with. Words come from the page, never from here.

(() => {
  /** Design sizes of the two compositions; the stage is scaled to its column. */
  const DESIGN = { wide: { width: 800, height: 500 }, compact: { width: 380, height: 620 } };
  /** Below this column width the wide composition stops reading, so the compact one takes over. */
  const COMPACT_BELOW = 560;
  const STATES = ["is-notice", "is-changed", "is-todo", "is-confirmed", "is-cursor", "is-pressing"];

  function must<T>(value: T | null | undefined, what: string): T {
    if (value === null || value === undefined) throw new RangeError(`site demo: no ${what}`);
    return value;
  }

  const section = must(document.currentScript?.closest("section"), "section");
  const wrap = must(section.querySelector<HTMLElement>(".stage-wrap"), "stage wrap");
  const stage = must(wrap.querySelector<HTMLElement>(".stage"), "stage");
  const cursor = must(stage.querySelector<SVGElement>(".cursor"), "cursor");
  const confirm = must(stage.querySelector<HTMLElement>("[data-target=confirm]"), "confirm button");
  const steps = must(section.querySelector<HTMLElement>(".steps"), "steps");
  const replay = must(section.querySelector<HTMLButtonElement>(".replay"), "replay button");
  const still = window.matchMedia("(prefers-reduced-motion: reduce)");

  let scale = 1;
  let timers: number[] = [];

  function fit(): void {
    const width = wrap.clientWidth;
    const layout = width < COMPACT_BELOW ? "compact" : "wide";
    const size = DESIGN[layout];
    stage.dataset.layout = layout;
    scale = width / size.width;
    stage.style.transform = `scale(${scale})`;
    wrap.style.height = `${Math.round(size.height * scale)}px`;
  }

  function setStep(n: number): void {
    steps.classList.toggle("is-playing", n > 0);
    for (const li of steps.querySelectorAll<HTMLElement>("li")) {
      if (li.dataset.step === String(n)) li.setAttribute("aria-current", "step");
      else li.removeAttribute("aria-current");
    }
  }

  /** Puts the cursor on a point of the stage, in design pixels. */
  function point(x: number, y: number): void {
    cursor.style.setProperty("--cx", `${x}px`);
    cursor.style.setProperty("--cy", `${y}px`);
  }

  /** Aims inside the button but off its words, as a hand would. */
  function aimAtConfirm(): void {
    const s = stage.getBoundingClientRect();
    const b = confirm.getBoundingClientRect();
    point((b.left - s.left + b.width * 0.86) / scale, (b.top - s.top + b.height * 0.62) / scale);
  }

  function set(on: string[], off: string[] = []): void {
    for (const c of on) stage.classList.add(c);
    for (const c of off) stage.classList.remove(c);
  }

  function beat(step: number, on: string[], off: string[] = []): void {
    set(on, off);
    setStep(step);
  }

  function end(): void {
    replay.hidden = false;
    setStep(0);
  }

  function rewind(): void {
    stage.classList.remove("is-live", ...STATES);
    const b = confirm.getBoundingClientRect();
    const s = stage.getBoundingClientRect();
    // Start the hand below and to the right of where it will press.
    point((b.right - s.left) / scale + 70, (b.bottom - s.top) / scale + 80);
    void stage.offsetWidth;
    stage.classList.add("is-live");
  }

  function play(): void {
    for (const t of timers) window.clearTimeout(t);
    timers = [];
    replay.hidden = true;
    rewind();
    const cues: [number, () => void][] = [
      [700, () => beat(1, ["is-notice"])],
      [2700, () => beat(2, ["is-changed"])],
      [5300, () => beat(3, ["is-todo"], ["is-notice"])],
      [6300, () => set(["is-cursor"])],
      [6450, aimAtConfirm],
      [7550, () => set(["is-pressing"])],
      [7700, () => set(["is-confirmed"], ["is-pressing"])],
      [9300, () => set([], ["is-cursor"])],
      [10000, end],
    ];
    timers = cues.map(([at, run]) => window.setTimeout(run, at));
  }

  fit();
  new ResizeObserver(fit).observe(wrap);
  if (still.matches) return;

  // Show the opening frame now, so the result is never seen rewinding.
  stage.classList.remove(...STATES);
  // Replay fades the stage out, rewinds it unseen, and fades the opening frame back in.
  replay.addEventListener("click", () => {
    stage.style.opacity = "0";
    window.setTimeout(() => {
      play();
      window.requestAnimationFrame(() => {
        stage.style.opacity = "";
      });
    }, 220);
  });
  stage.style.transition = "opacity 0.2s";
  const seen = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        seen.disconnect();
        play();
      }
    },
    { threshold: 0.5 },
  );
  seen.observe(wrap);
})();

// Copying the contact address; the link next to it may do nothing where mail links are blocked.
document.addEventListener("click", (event) => {
  const button = (event.target as Element | null)?.closest<HTMLButtonElement>("button[data-copy]");
  if (!button) return;
  const text = button.dataset.copy ?? "";
  const label = button.textContent ?? "";
  const done = () => {
    button.textContent = button.dataset.done ?? label;
    window.setTimeout(() => {
      button.textContent = label;
    }, 1600);
  };
  const select = () => {
    const address = button.parentElement?.querySelector(".address");
    if (address) window.getSelection()?.selectAllChildren(address);
  };
  navigator.clipboard?.writeText(text).then(done, select) ?? select();
});
