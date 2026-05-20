(function (global) {
  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  const money = (amount, currencyCode = "MYR") =>
    new Intl.NumberFormat("ms-MY", {
      style: "currency",
      currency: currencyCode || "MYR",
    }).format(Number(amount || 0));

  function productTypeLabel(product) {
    const type = String(product.productType || "").trim();
    return type || "Product";
  }

  function parseProductTags(raw) {
    if (Array.isArray(raw)) {
      return raw.map((tag) => String(tag || "").trim()).filter(Boolean);
    }
    if (typeof raw === "string" && raw.trim()) {
      return raw.split(",").map((tag) => tag.trim()).filter(Boolean);
    }
    return [];
  }

  function isCatalogBadgeTag(tag) {
    const normalized = String(tag || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
    return (
      normalized === "new" ||
      normalized === "best seller" ||
      normalized === "bestseller" ||
      normalized === "best-seller" ||
      normalized === "max savings" ||
      normalized === "early bird discount"
    );
  }

  function getProductBadgesHtml(product, maxBadges = 2) {
    const tags = parseProductTags(product.tags);
    const badgeTags = tags.filter((tag) => isCatalogBadgeTag(tag)).slice(0, maxBadges);
    if (!badgeTags.length) return "";
    return (
      '<div class="catalog-badges">' +
      badgeTags
        .map((tag) => '<span class="catalog-badge">' + escapeHtml(tag) + "</span>")
        .join("") +
      "</div>"
    );
  }

  function buildCatalogPriceHtml(product) {
    const minPrice = product.priceRange?.minVariantPrice;
    if (!minPrice) return '<span class="catalog-price">-</span>';

    const comparePrice = product.compareAtPriceRange?.minVariantPrice;
    const sale =
      comparePrice && Number(comparePrice.amount) > Number(minPrice.amount || 0);

    if (!sale) {
      return '<span class="catalog-price">' + money(minPrice.amount, minPrice.currencyCode) + "</span>";
    }

    const original = Number(comparePrice.amount);
    const current = Number(minPrice.amount);
    const pct =
      original > 0 && current < original
        ? Math.round((1 - current / original) * 100)
        : 0;
    const saveHint =
      pct > 0 && pct < 100 ? '<span class="catalog-badge">-' + pct + "%</span>" : "";

    return (
      '<div class="catalog-price-block">' +
      '<span class="catalog-price">' +
      money(minPrice.amount, minPrice.currencyCode) +
      "</span>" +
      '<div class="catalog-price-meta">' +
      '<span class="catalog-old">' +
      money(comparePrice.amount, comparePrice.currencyCode) +
      "</span>" +
      saveHint +
      "</div></div>"
    );
  }

  function buildCatalogCardHtml(product) {
    const firstVariant = product.variants?.nodes?.[0];
    const priceHtml = buildCatalogPriceHtml(product);

    const badge = getProductBadgesHtml(product);

    const imageUrl = String(product.featuredImage?.url || "").trim();
    const image = imageUrl
      ? "style=\"background-image:url('" +
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
      "<div>" +
      priceHtml +
      "</div>" +
      '<button type="button" class="catalog-view">View</button>' +
      "</div>" +
      "</div>" +
      "</a>"
    );
  }

  function renderCatalogGrid(container, products, options = {}) {
    if (!container) return;
    const { excludeHandle, limit, emptyMessage } = options;
    let list = Array.isArray(products) ? products.slice() : [];
    if (excludeHandle) {
      list = list.filter((p) => String(p.handle || "") !== String(excludeHandle));
    }
    if (typeof limit === "number" && limit > 0) {
      list = list.slice(0, limit);
    }
    if (!list.length) {
      container.innerHTML =
        emptyMessage ||
        '<div class="catalog-card" style="grid-column:1/-1;padding:18px;">No products to show.</div>';
      return;
    }
    container.innerHTML = list.map((product) => buildCatalogCardHtml(product)).join("");
  }

  global.flexcaseCatalogCards = {
    escapeHtml,
    money,
    productTypeLabel,
    getProductBadgesHtml,
    buildCatalogCardHtml,
    renderCatalogGrid,
  };
})(window);
