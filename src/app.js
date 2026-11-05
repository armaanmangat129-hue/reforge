/* Reforge entry point: navigation, the progress badge, and start-up. */

(() => {
  const { icon } = R;

  const TABS = [
    { id: "home", label: "Home" },
    { id: "library", label: "Library" },
    { id: "study", label: "Study" },
    { id: "tutor", label: "Tutor" },
    { id: "planner", label: "Planner" },
    { id: "settings", label: "Settings" },
  ];

  document.querySelectorAll("[data-nav]").forEach((nav) => {
    nav.innerHTML = TABS.map((t) => `<a href="#/${t.id}" data-tab="${t.id}">${icon(t.id)}<span>${t.label}</span><span class="nav-badge" data-badge="${t.id}" hidden></span></a>`).join("");
  });

  /* Level and streak in the sidebar and top bar, plus the due count on Study. */
  async function refreshBadges() {
    const [prog, due] = await Promise.all([SRS.getProgress(), SRS.dueCards()]);
    const lvl = SRS.level(prog.xp);
    document.querySelectorAll("[data-progress]").forEach((el) => {
      el.hidden = prog.xp === 0;
      el.innerHTML = `<span class="pb-level">Level ${lvl.level}</span>${prog.streak ? `<span class="pb-streak">${icon("flame")}${prog.streak}</span>` : ""}`;
      el.setAttribute("aria-label", `Level ${lvl.level}${prog.streak ? `, ${prog.streak}-day streak` : ""}`);
    });
    document.querySelectorAll('[data-badge="study"]').forEach((b) => {
      b.hidden = !due.length;
      b.textContent = due.length > 99 ? "99+" : due.length;
    });
  }
  window.addEventListener("reforge:progress", refreshBadges);
  window.addEventListener("hashchange", refreshBadges);

  // Installable app + offline: register the service worker (needs https or localhost)
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }

  if (!location.hash) history.replaceState(null, "", "#/home");
  R.render();
  refreshBadges();
})();
