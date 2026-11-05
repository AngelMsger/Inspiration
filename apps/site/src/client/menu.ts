// The language menus, in the header and the footer. Each is a <details>, so it opens and works
// without script; this only closes them the way a menu is expected to close: on a click
// outside, or on Escape, which also gives focus back to the menu's button. It is inlined in the
// header, before the footer is parsed, so it looks the menus up when an event comes.

(() => {
  const open = () => [...document.querySelectorAll<HTMLDetailsElement>("details.lang-menu[open]")];

  document.addEventListener("click", (e) => {
    for (const menu of open()) if (!menu.contains(e.target as Node)) menu.open = false;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    for (const menu of open()) {
      menu.open = false;
      menu.querySelector("summary")?.focus();
    }
  });
})();
