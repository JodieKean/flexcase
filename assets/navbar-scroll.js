(function () {
  const header = document.querySelector(".site-header");
  if (!header) return;

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
    catalogReachY = Math.max(0, top - header.offsetHeight);
  }

  function updateStickyOffsets() {
    const hidden = header.classList.contains("is-hidden");
    const offset = hidden ? 0 : header.offsetHeight;
    const promo = header.querySelector(".site-promo-banner");
    const promoHeight = promo ? promo.offsetHeight : 0;
    document.documentElement.style.setProperty("--flexcase-promo-banner-height", `${promoHeight}px`);
    document.documentElement.style.setProperty("--catalog-sticky-top", `${offset}px`);
    document.documentElement.style.setProperty("--flexcase-site-header-offset", `${offset || header.offsetHeight}px`);
  }

  function setHeaderHidden(hidden) {
    header.classList.toggle("is-hidden", hidden);
    document.body.classList.toggle("navbar-hidden", hidden);
    updateStickyOffsets();
  }

  function unstuckToolbar() {
    const toolbar = getCatalogToolbar();
    if (!toolbar) return;
    toolbar.classList.remove("is-stuck");
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

    if (toolbarPlaceholder) {
      toolbarPlaceholder.style.height = `${toolbar.offsetHeight}px`;
    }
  }

  function updateNavbarVisibility() {
    ticking = false;
    if (!mobileQuery.matches) {
      setHeaderHidden(false);
      unstuckToolbar();
      lastScrollY = window.scrollY;
      return;
    }

    const currentY = window.scrollY;

    if (currentY < catalogReachY) {
      setHeaderHidden(false);
      lastScrollY = currentY;
      return;
    }

    if (currentY > lastScrollY + 6) {
      setHeaderHidden(true);
    } else if (currentY < lastScrollY - 6) {
      setHeaderHidden(false);
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
  window.addEventListener("flexcase:navigate", remeasure);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", remeasure);
  }
  mobileQuery.addEventListener("change", () => {
    lastScrollY = window.scrollY;
    setHeaderHidden(false);
    remeasure();
  });

  remeasure();
})();
