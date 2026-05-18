(function () {
  const nav = document.querySelector(".site-navbar");
  if (!nav) return;

  const mobileQuery = window.matchMedia("(max-width: 980px)");
  let lastScrollY = window.scrollY;
  let ticking = false;
  let catalogReachY = Infinity;

  function getCatalogToolbar() {
    return document.querySelector("#catalog .catalog-toolbar");
  }

  function measureCatalogReachY() {
    const toolbar = getCatalogToolbar();
    if (!toolbar) {
      catalogReachY = Infinity;
      return;
    }
    let top = 0;
    let el = toolbar;
    while (el) {
      top += el.offsetTop;
      el = el.offsetParent;
    }
    catalogReachY = Math.max(0, top - nav.offsetHeight);
  }

  function updateStickyOffsets() {
    const hidden = nav.classList.contains("is-hidden");
    const top = hidden ? 0 : nav.offsetHeight;
    document.documentElement.style.setProperty("--catalog-sticky-top", `${top}px`);
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

    if (currentY < catalogReachY) {
      setNavbarHidden(false);
      lastScrollY = currentY;
      return;
    }

    if (currentY > lastScrollY + 6) {
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

  function remeasure() {
    measureCatalogReachY();
    updateStickyOffsets();
    updateNavbarVisibility();
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", remeasure);
  window.addEventListener("load", remeasure);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", remeasure);
  }
  mobileQuery.addEventListener("change", () => {
    lastScrollY = window.scrollY;
    setNavbarHidden(false);
    remeasure();
  });

  remeasure();
})();
