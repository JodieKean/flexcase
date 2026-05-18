(function () {
  const nav = document.querySelector(".site-navbar");
  if (!nav) return;

  const mobileQuery = window.matchMedia("(max-width: 980px)");
  let lastScrollY = window.scrollY;
  let ticking = false;

  function updateStickyOffsets() {
    const hidden = nav.classList.contains("is-hidden");
    const top = hidden ? 0 : nav.offsetHeight;
    document.documentElement.style.setProperty("--catalog-sticky-top", `${top}px`);
    window.dispatchEvent(new CustomEvent("flexcase-navbar-offset-change"));
  }

  function setNavbarHidden(hidden) {
    nav.classList.toggle("is-hidden", hidden);
    document.body.classList.toggle("navbar-hidden", hidden);
    updateStickyOffsets();
  }

  function updateNavbarVisibility() {
    ticking = false;
    if (!mobileQuery.matches) {
      setNavbarHidden(false);
      lastScrollY = window.scrollY;
      return;
    }

    const currentY = window.scrollY;
    if (currentY <= 8) {
      setNavbarHidden(false);
    } else if (currentY > lastScrollY + 6) {
      setNavbarHidden(true);
    } else if (currentY < lastScrollY - 6) {
      setNavbarHidden(false);
    }
    lastScrollY = currentY;
  }

  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(updateNavbarVisibility);
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", updateStickyOffsets);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", updateStickyOffsets);
  }
  mobileQuery.addEventListener("change", () => {
    lastScrollY = window.scrollY;
    setNavbarHidden(false);
    updateNavbarVisibility();
    updateStickyOffsets();
  });

  updateStickyOffsets();
  updateNavbarVisibility();
})();
