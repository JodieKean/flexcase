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
  if (!grid) return;

  let allProducts = [];
  let activeType = "All";
  let searchQuery = "";

  const money = (amount, currencyCode = "MYR") =>
    new Intl.NumberFormat("ms-MY", {
      style: "currency",
      currency: currencyCode || "MYR",
    }).format(Number(amount || 0));

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function productTypeLabel(product) {
    const type = String(product.productType || "").trim();
    return type || "Product";
  }

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

    grid.innerHTML = products
      .map((product, index) => {
        const firstVariant = product.variants?.nodes?.[0];
        const minPrice = product.priceRange?.minVariantPrice;
        const comparePrice = product.compareAtPriceRange?.minVariantPrice;
        const price = minPrice ? money(minPrice.amount, minPrice.currencyCode) : "-";
        const oldPrice =
          comparePrice && Number(comparePrice.amount) > Number(minPrice?.amount || 0)
            ? '<span class="catalog-old">' +
              money(comparePrice.amount, comparePrice.currencyCode) +
              "</span>"
            : "";

        const badge =
          index === 0
            ? '<span class="catalog-badge">Best Seller</span>'
            : index === 1
              ? '<span class="catalog-badge">New</span>'
              : "";

        const imageUrl = String(product.featuredImage?.url || "").trim();
        const image = imageUrl
          ? 'style="background-image:url(\'' +
            imageUrl.replace(/'/g, "%27") +
            "');background-size:cover;background-position:center;\""
          : "";

        const title = escapeHtml(product.title);
        const kind = escapeHtml(productTypeLabel(product));
        const handle = encodeURIComponent(product.handle || "");
        const stock = firstVariant?.availableForSale ? "In stock" : "Out of stock";

        return (
          '<a class="catalog-card catalog-link" href="Product.html?handle=' +
          handle +
          '" aria-label="View ' +
          title +
          '">' +
          '<div class="catalog-image" ' +
          image +
          ">" +
          badge +
          "</div>" +
          '<div class="catalog-card-body">' +
          '<div class="catalog-kind">' +
          kind +
          "</div>" +
          '<div class="catalog-title">' +
          title +
          "</div>" +
          '<div class="catalog-rating">' +
          stock +
          "</div>" +
          '<div class="catalog-footer">' +
          "<div><span class=\"catalog-price\">" +
          price +
          "</span>" +
          oldPrice +
          "</div>" +
          '<button type="button" class="catalog-view">View</button>' +
          "</div>" +
          "</div>" +
          "</a>"
        );
      })
      .join("");
    updateMeta(products.length);
  }

  function applyCatalogFilters() {
    renderCatalogCards(getFilteredProducts());
  }

  if (searchEl) {
    searchEl.addEventListener("input", () => {
      searchQuery = searchEl.value;
      applyCatalogFilters();
    });
  }

  try {
    const response = await fetchApiWithFallback("/api/catalog?first=100");
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Catalog request failed.");
    }
    allProducts = payload.products || [];
    renderCategoryChips(collectProductTypes(allProducts));
    applyCatalogFilters();
  } catch (error) {
    grid.innerHTML =
      '<div class="catalog-card" style="grid-column:1/-1;padding:18px;">Failed to load catalog: ' +
      escapeHtml(error.message) +
      "</div>";
    if (countEl) countEl.textContent = "Unable to load products";
  }
})();
