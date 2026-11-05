// The header's language menu, inlined right after it. It is a <details>, so it opens and
// works without script; this only closes it the way a menu is expected to close: on a click
// outside it, or on Escape, which also gives focus back to its button.

(() => {
  const menu = document.querySelector<HTMLDetailsElement>(".top .lang-menu");
  if (!menu) return;
  const details = menu;

  document.addEventListener("click", (e) => {
    if (details.open && !details.contains(e.target as Node)) details.open = false;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !details.open) return;
    details.open = false;
    details.querySelector("summary")?.focus();
  });
})();
