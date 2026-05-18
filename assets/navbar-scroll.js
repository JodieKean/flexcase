(function () {
  const nav = document.querySelector(".site-navbar");
  if (!nav) return;

  const mobileQuery = window.matchMedia("(max-width: 980px)");
  let lastScrollY = window.scrollY;
  let ticking = false;
  let catalogReachY = Infinity;
  let toolbarPlaceholder = null;

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

  function getStickyTopPx() {
    const raw = getComputedStyle(document.documentElement).getPropertyValue("--catalog-sticky-top");
    const parsed = parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : nav.offsetHeight;
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

  function setToolbarHidden(hidden) {
    const toolbar = getCatalogToolbar();
    if (!toolbar) return;
    toolbar.classList.toggle("is-hidden", hidden);
  }

  function unstuckToolbar() {
    const toolbar = getCatalogToolbar();
    if (!toolbar) return;
    toolbar.classList.remove("is-stuck", "is-hidden");
    toolbar.style.top = "";
    toolbarPlaceholder?.remove();
    toolbarPlaceholder = null;
  }

  function updateToolbarStuck() {
    const toolbar = getCatalogToolbar();
    if (!toolbar || !mobileQuery.matches) {
      unstuckToolbar();
      return;
    }

    if (window.scrollY < catalogReachY - 1) {
      unstuckToolbar();
      return;
    }

    if (!toolbar.classList.contains("is-stuck")) {
      const height = toolbar.offsetHeight;
      toolbarPlaceholder = document.createElement("div");
      toolbarPlaceholder.className = "catalog-toolbar-placeholder";
      toolbarPlaceholder.setAttribute("aria-hidden", "true");
      toolbarPlaceholder.style.height = `${height}px`;
      toolbar.parentNode.insertBefore(toolbarPlaceholder, toolbar);
      toolbar.classList.add("is-stuck");
    }

    toolbar.style.top = `${getStickyTopPx()}px`;
    if (toolbarPlaceholder) {
      toolbarPlaceholder.style.height = `${toolbar.offsetHeight}px`;
    }
  }

  function refreshToolbarTop() {
    const toolbar = getCatalogToolbar();
    if (toolbar?.classList.contains("is-stuck")) {
      toolbar.style.top = `${getStickyTopPx()}px`;
    }
  }

  function setChromeHidden(hidden) {
    setNavbarHidden(hidden);
    setToolbarHidden(hidden);
    refreshToolbarTop();
  }

  function updateNavbarVisibility() {
    ticking = false;
    if (!mobileQuery.matches) {
      setChromeHidden(false);
      unstuckToolbar();
      lastScrollY = window.scrollY;
      return;
    }

    const currentY = window.scrollY;

    if (currentY < catalogReachY) {
      setChromeHidden(false);
      lastScrollY = currentY;
      return;
    }

    if (currentY > lastScrollY + 6) {
      setChromeHidden(true);
    } else if (currentY < lastScrollY - 6) {
      setChromeHidden(false);
    }
    lastScrollY = currentY;
  }

  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      updateToolbarStuck();
      updateNavbarVisibility();
    });
  }

  function remeasure() {
    const toolbar = getCatalogToolbar();
    const wasStuck = toolbar?.classList.contains("is-stuck");
    if (wasStuck) unstuckToolbar();
    measureCatalogReachY();
    updateStickyOffsets();
    updateToolbarStuck();
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
    setChromeHidden(false);
    remeasure();
  });

  remeasure();
})();
