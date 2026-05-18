(async function initShopifyCatalog() {
  const API_BASE = (window.FLEXCASE_API_BASE || "https://api.flexcase.my").replace(/\/$/, "");
  const apiUrl = (pathname) => `${API_BASE}${pathname}`;
  const localApiUrl = (pathname) => pathname;
  async function fetchApiWithFallback(pathname) {
    try {
      return await fetch(apiUrl(pathname));
    } catch (_) {
      return fetch(localApiUrl(pathname));
    }
  }
  const grid = document.getElementById("catalogGrid");
  const categoriesEl = document.getElementById("catalogCategories");
  const searchEl = document.getElementById("catalogSearch");
  const countEl = document.querySelector(".catalog-meta");
  const cards = window.flexcaseCatalogCards;
  if (!grid || !cards) return;

  let allProducts = [];
  let activeType = "All";
  let searchQuery = "";

  const { escapeHtml, productTypeLabel, renderCatalogGrid } = cards;

  function collectProductTypes(products) {
    const types = new Set();
    products.forEach((product) => {
      const type = String(product.productType || "").trim();
      if (type) types.add(type);
    });
    return Array.from(types).sort((a, b) => a.localeCompare(b));
  }

  function matchesSearch(product, query) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return true;
    const title = String(product.title || "").toLowerCase();
    const type = String(product.productType || "").toLowerCase();
    return title.includes(q) || type.includes(q);
  }

  function matchesType(product, typeFilter) {
    if (!typeFilter || typeFilter === "All") return true;
    return String(product.productType || "").trim() === typeFilter;
  }

  function getFilteredProducts() {
    return allProducts.filter(
      (product) => matchesType(product, activeType) && matchesSearch(product, searchQuery)
    );
  }

  function updateMeta(count) {
    if (!countEl) return;
    const q = searchQuery.trim();
    const typeSuffix = activeType === "All" ? "" : ` in ${activeType}`;
    if (q) {
      countEl.textContent =
        count === 1
          ? `1 product found matching "${q}"${typeSuffix}`
          : `${count} products found matching "${q}"${typeSuffix}`;
    } else {
      countEl.textContent =
        count === 1 ? `1 product found${typeSuffix}` : `${count} products found${typeSuffix}`;
    }
  }

  function renderCategoryChips(types) {
    if (!categoriesEl) return;
    const labels = ["All", ...types];
    categoriesEl.innerHTML = labels
      .map((label) => {
        const active = label === activeType ? " active" : "";
        const selected = label === activeType;
        return (
          '<button type="button" class="catalog-chip' +
          active +
          '" data-product-type="' +
          escapeHtml(label) +
          '" role="tab" aria-selected="' +
          (selected ? "true" : "false") +
          '">' +
          escapeHtml(label) +
          "</button>"
        );
      })
      .join("");

    categoriesEl.onclick = (event) => {
      const chip = event.target.closest("[data-product-type]");
      if (!chip) return;
      const next = chip.getAttribute("data-product-type") || "All";
      if (next === activeType) return;
      activeType = next;
      categoriesEl.querySelectorAll(".catalog-chip").forEach((btn) => {
        const label = btn.getAttribute("data-product-type") || "";
        const isActive = label === activeType;
        btn.classList.toggle("active", isActive);
        btn.setAttribute("aria-selected", isActive ? "true" : "false");
      });
      applyCatalogFilters();
    };
  }

  function renderCatalogCards(products) {
    if (!allProducts.length) {
      grid.innerHTML =
        '<div class="catalog-card" style="grid-column:1/-1;padding:18px;">No Shopify products yet. Add products in your Shopify admin, then refresh.</div>';
      updateMeta(0);
      return;
    }
    if (!products.length) {
      grid.innerHTML =
        '<div class="catalog-card" style="grid-column:1/-1;padding:18px;">No products match your search. Try another name or product type.</div>';
      updateMeta(0);
      return;
    }

    renderCatalogGrid(grid, products);
    updateMeta(products.length);
  }

  function applyCatalogFilters() {
    renderCatalogCards(getFilteredProducts());
    scrollToCatalogFromHash();
  }

  function scrollToCatalogFromHash() {
    const hash = window.location.hash.replace(/^#/, "");
    if (hash !== "catalog") return;
    const section = document.getElementById("catalog");
    if (!section) return;
    const toolbar = section.querySelector(".catalog-toolbar") || section;
    const navOffset = 72;
    const top = toolbar.getBoundingClientRect().top + window.pageYOffset - navOffset;
    window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    const search = document.getElementById("catalogSearch");
    if (search) search.focus({ preventScroll: true });
  }

  if (searchEl) {
    searchEl.addEventListener("input", () => {
      searchQuery = searchEl.value;
      applyCatalogFilters();
    });
  }

  window.addEventListener("hashchange", scrollToCatalogFromHash);

  try {
    const response = await fetchApiWithFallback("/api/catalog?first=100");
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Catalog request failed.");
    }
    allProducts = payload.products || [];
    renderCategoryChips(collectProductTypes(allProducts));
    applyCatalogFilters();
    requestAnimationFrame(() => requestAnimationFrame(scrollToCatalogFromHash));
  } catch (error) {
    grid.innerHTML =
      '<div class="catalog-card" style="grid-column:1/-1;padding:18px;">Failed to load catalog: ' +
      escapeHtml(error.message) +
      "</div>";
    if (countEl) countEl.textContent = "Unable to load products";
  }
})();
