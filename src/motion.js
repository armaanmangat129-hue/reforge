/* Motion Effects: scroll reveal, adapted for a single-page app.
   Marks <html> as motion-enabled. Call Motion.reveal(root) after each render
   to reveal .reveal elements as they enter the screen. */

const Motion = (() => {
  document.documentElement.classList.add("js-motion");

  const supported = "IntersectionObserver" in window;
  const observer = supported
    ? new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const el = entry.target;
            el.classList.add("is-visible");
            observer.unobserve(el);
            // Clear the stagger so later hover transitions aren't delayed.
            setTimeout(() => { el.style.transitionDelay = ""; }, 900);
          }
        });
      }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" })
    : null;

  function reveal(root = document) {
    root.querySelectorAll(".reveal:not(.is-visible)").forEach((el, i) => {
      if (!observer) return el.classList.add("is-visible");
      el.style.transitionDelay = `${Math.min(i, 8) * 40}ms`;
      observer.observe(el);
    });
  }

  return { reveal };
})();
