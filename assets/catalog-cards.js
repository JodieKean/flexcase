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

  function buildCatalogCardHtml(product, index) {
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
    container.innerHTML = list.map((product, index) => buildCatalogCardHtml(product, index)).join("");
  }

  global.flexcaseCatalogCards = {
    escapeHtml,
    money,
    productTypeLabel,
    buildCatalogCardHtml,
    renderCatalogGrid,
  };
})(window);
