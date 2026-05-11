(function () {
  const CART_KEY = "flexcase.local.cart";
  const MERGED_KEY = "flexcase_guest_cart_merged";
  const LAST_PATH_KEY = "flexcase.last.path";
  const LAST_AUTH_IDENTITY_KEY = "flexcase.last.auth.identity";
  /** Set when redirecting to Shopify checkout; cleared on next reconcile (load or bfcache pageshow). */
  const CHECKOUT_HANDOFF_KEY = "flexcase.checkout_handoff_pending";
  let latestReplaceSyncRequestId = 0;
  const REPLACE_SYNC_DEBOUNCE_MS = Number(window.FLEXCASE_CART_SYNC_DEBOUNCE_MS || 800);
  /** Brief pause before GET /api/cart after replace so Shopify read-your-writes can settle. */
  const PULL_AFTER_REPLACE_MS = 350;
  let replaceSyncTimer = null;
  let replaceSyncPendingResolvers = [];
  const SYNC_ONLY_ON_EXIT = false;
  /** Ensures at most one /api/cart/replace is in flight so older payloads cannot win on the server. */
  let replaceSyncChain = Promise.resolve();

  function apiBase() {
    return (window.FLEXCASE_API_BASE || "https://api.flexcase.my").replace(/\/$/, "");
  }

  function apiUrl(p) {
    return `${apiBase()}${p}`;
  }

  function localApiUrl(p) {
    return p;
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = 6000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchApi(path, options = {}) {
    const timeoutMs = Number(options?.timeoutMs || 6000);
    const fetchOptions = { ...options };
    delete fetchOptions.timeoutMs;
    try {
      return await fetchWithTimeout(
        apiUrl(path),
        { credentials: "include", ...fetchOptions },
        timeoutMs
      );
    } catch (_) {
      return fetchWithTimeout(
        localApiUrl(path),
        { credentials: "include", ...fetchOptions },
        Math.max(2500, Math.min(timeoutMs, 5000))
      );
    }
  }

  function readLocalLines() {
    try {
      const raw = localStorage.getItem(CART_KEY) || "[]";
      const a = JSON.parse(raw);
      return Array.isArray(a) ? a : [];
    } catch (_) {
      return [];
    }
  }

  function writeLocalLines(lines) {
    localStorage.setItem(CART_KEY, JSON.stringify(Array.isArray(lines) ? lines : []));
    window.dispatchEvent(new CustomEvent("flexcase-cart-updated"));
  }

  /** Storefront cart + checkout require this GID shape; numeric IDs must be coerced. */
  function normalizeStorefrontVariantGid(raw) {
    const s = String(raw ?? "").trim();
    if (!s) return "";
    if (s.startsWith("gid://shopify/ProductVariant/")) return s;
    const m = s.match(/ProductVariant\/(\d+)/i);
    if (m?.[1]) return `gid://shopify/ProductVariant/${m[1]}`;
    if (/^\d+$/.test(s)) return `gid://shopify/ProductVariant/${s}`;
    return "";
  }

  function lineIdentity(line) {
    const norm = normalizeStorefrontVariantGid(line?.variantId);
    if (norm) return `variant:${norm}`;
    const raw = String(line?.variantId || "").trim();
    if (raw) return `variant:${raw}`;
    const fallback = `${String(line?.productTitle || "").trim()}|${String(line?.variantTitle || "").trim()}`;
    return `title:${fallback}`;
  }

  /**
   * One row per lineIdentity; duplicate rows (same variant) merge by summing quantity.
   * Previously the first row won and later rows were dropped, which could freeze qty at 1
   * if a stale duplicate appeared first in localStorage.
   */
  function dedupeByIdentity(lines) {
    const byKey = new Map();
    for (const line of Array.isArray(lines) ? lines : []) {
      const normVid = normalizeStorefrontVariantGid(line?.variantId);
      const storedLine =
        normVid.startsWith("gid://shopify/ProductVariant/") ? { ...line, variantId: normVid } : { ...line };
      const key = lineIdentity(storedLine);
      if (!key) continue;
      const qty = Math.max(1, Math.min(99, Number(line.quantity || 1)));
      if (!byKey.has(key)) {
        byKey.set(key, { ...storedLine, quantity: qty });
      } else {
        const prev = byKey.get(key);
        byKey.set(key, {
          ...prev,
          quantity: Math.min(99, Number(prev.quantity || 1) + qty),
        });
      }
    }
    return [...byKey.values()];
  }

  function mergeWithStableOrder(nextLines, previousLines, newItemsOnTop = false) {
    const prev = dedupeByIdentity(previousLines);
    const next = dedupeByIdentity(nextLines);
    if (!next.length) return [];

    const prevOrder = new Map(prev.map((line, idx) => [lineIdentity(line), idx]));
    const existing = [];
    const newcomers = [];

    for (const line of next) {
      const key = lineIdentity(line);
      if (prevOrder.has(key)) existing.push(line);
      else newcomers.push(line);
    }

    existing.sort((a, b) => prevOrder.get(lineIdentity(a)) - prevOrder.get(lineIdentity(b)));
    return newItemsOnTop ? [...newcomers, ...existing] : [...existing, ...newcomers];
  }

  function cartTotalQty(lines) {
    return (lines || []).reduce((s, l) => {
      const q = Number(l.quantity);
      if (Number.isFinite(q) && q >= 1) return s + Math.min(99, q);
      return s + 1;
    }, 0);
  }

  function updateBadges() {
    const qty = cartTotalQty(readLocalLines());
    document.querySelectorAll(".cart-badge").forEach((el) => {
      el.textContent = String(qty);
      el.style.display = qty > 0 ? "" : "none";
    });
  }

  window.addEventListener("flexcase-cart-updated", updateBadges);

  function sessionIdentity(sessionPayload) {
    const id = String(sessionPayload?.customer?.id || "").trim();
    if (id) return `id:${id}`;
    const email = String(sessionPayload?.customer?.email || "")
      .trim()
      .toLowerCase();
    if (email) return `email:${email}`;
    return "";
  }

  async function getSessionState() {
    try {
      const r = await fetchApi("/api/customer/session");
      const j = await r.json();
      return {
        authenticated: Boolean(j?.authenticated),
        identity: sessionIdentity(j),
      };
    } catch (_) {
      return { authenticated: false, identity: "" };
    }
  }

  async function pullServerCartToLocalIfEmpty() {
    const local = readLocalLines();
    if (local.length) return true;
    const r = await fetchApi("/api/cart");
    if (!r.ok) return false;
    const j = await r.json().catch(() => ({}));
    const lines = Array.isArray(j?.lines) ? j.lines : [];
    if (lines.length) writeLocalLines(lines);
    return true;
  }

  function flexcaseMarkShopifyCheckoutHandoff() {
    try {
      sessionStorage.setItem(CHECKOUT_HANDOFF_KEY, "1");
    } catch (_) {
      /* ignore */
    }
  }

  /**
   * After returning from Shopify (or any navigation back), if the buyer had left for checkout:
   * signed-in users sync local from server — empty server clears local (order completed or cart cleared);
   * non-empty server restores lines (abandoned checkout). Guests keep localStorage (no /api/cart).
   */
  async function flexcaseReconcileAfterShopifyCheckoutReturn() {
    let pending = false;
    try {
      pending = sessionStorage.getItem(CHECKOUT_HANDOFF_KEY) === "1";
      if (!pending) return;
      sessionStorage.removeItem(CHECKOUT_HANDOFF_KEY);
    } catch (_) {
      return;
    }
    const session = await getSessionState();
    if (!session.authenticated) return;
    if (window.__flexcaseSkipHydrateWrite) return;
    const r = await fetchApi("/api/cart");
    if (!r.ok) return;
    const j = await r.json().catch(() => ({}));
    const lines = Array.isArray(j?.lines) ? j.lines : [];
    const totalQ = Number(j?.totalQuantity || 0);
    if (lines.length === 0 && totalQ === 0) {
      writeLocalLines([]);
    } else if (lines.length) {
      writeLocalLines(lines);
    }
    updateBadges();
  }

  async function pullServerCartToLocal() {
    const localBefore = readLocalLines();
    const r = await fetchApi("/api/cart");
    if (r.status === 401) return false;
    if (!r.ok) return false;
    const j = await r.json().catch(() => ({}));
    const lines = Array.isArray(j?.lines) ? j.lines : [];
    // Checkout can set this flag while user is actively editing quantity,
    // so late hydration responses never stomp local optimistic state.
    if (window.__flexcaseSkipHydrateWrite) return true;
    // Avoid wiping a non-empty local cart when the server is still empty because
    // /api/cart/replace has not finished yet (e.g. user left checkout before Shopify caught up).
    if (lines.length === 0 && localBefore.length > 0) {
      return true;
    }
    writeLocalLines(lines);
    return true;
  }

  async function mergeGuestThenPull() {
    if (sessionStorage.getItem(MERGED_KEY)) return;
    sessionStorage.setItem(MERGED_KEY, "1");
  }

  async function flexcaseSyncCartAfterAuth() {
    const session = await getSessionState();
    if (!session.authenticated) return;
    await mergeGuestThenPull();
    const priorIdentity = String(sessionStorage.getItem(LAST_AUTH_IDENTITY_KEY) || "").trim();
    const currentIdentity = String(session.identity || "").trim();
    const accountSwitched = Boolean(priorIdentity && currentIdentity && priorIdentity !== currentIdentity);
    // Keep local UI stable by default, but always hydrate if account changed.
    const local = readLocalLines();
    if (accountSwitched || !local.length) {
      await pullServerCartToLocal().catch(() => false);
    } else if (local.length) {
      await runReplaceSyncNow().catch(() => false);
      await new Promise((resolve) => setTimeout(resolve, PULL_AFTER_REPLACE_MS));
      await pullServerCartToLocal().catch(() => false);
    }
    if (currentIdentity) sessionStorage.setItem(LAST_AUTH_IDENTITY_KEY, currentIdentity);
    updateBadges();
  }

  async function flexcaseRefreshCartFromServer() {
    // Push local to Shopify, apply replace response to storage, then pull after a short delay
    // so other devices / tabs converge without relying on a possibly immediate stale GET.
    const session = await getSessionState();
    if (!session.authenticated) return false;
    const hadLocal = readLocalLines().length > 0;
    if (hadLocal) {
      const flushOk = Boolean(await flexcaseFlushCartSync({ force: true }).catch(() => false));
      if (!flushOk) {
        updateBadges();
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, PULL_AFTER_REPLACE_MS));
    }
    const ok = await pullServerCartToLocal().catch(() => false);
    if (ok && session.identity) sessionStorage.setItem(LAST_AUTH_IDENTITY_KEY, session.identity);
    updateBadges();
    return ok;
  }

  async function flexcaseHydrateLocalCartFromServer() {
    const session = await getSessionState();
    if (!session.authenticated) return false;
    const hadLocal = readLocalLines().length > 0;
    if (hadLocal) {
      const flushOk = Boolean(await flexcaseFlushCartSync({ force: true }).catch(() => false));
      if (!flushOk) {
        updateBadges();
        return false;
      }
      await new Promise((resolve) => setTimeout(resolve, PULL_AFTER_REPLACE_MS));
    }
    const ok = await pullServerCartToLocal().catch(() => false);
    if (ok && session.identity) sessionStorage.setItem(LAST_AUTH_IDENTITY_KEY, session.identity);
    updateBadges();
    return ok;
  }

  async function flexcaseHydrateLocalCartQuantitiesFromServer() {
    const session = await getSessionState();
    if (!session.authenticated) return { ok: false, lines: [] };
    const r = await fetchApi("/api/cart").catch(() => null);
    if (!r || r.status === 401 || !r.ok) return { ok: false, lines: [] };
    const j = await r.json().catch(() => ({}));
    const serverLines = Array.isArray(j?.lines) ? j.lines : [];
    const local = readLocalLines();
    const byVariantId = new Map(
      serverLines.map((line) => [String(line?.variantId || "").trim(), Math.max(1, Number(line?.quantity || 1))])
    );
    const merged = local.map((line) => {
      const key = normalizeStorefrontVariantGid(line?.variantId) || String(line?.variantId || "").trim();
      if (!key || !byVariantId.has(key)) return line;
      return { ...line, quantity: byVariantId.get(key), variantId: key };
    });
    writeLocalLines(merged);
    if (session.identity) sessionStorage.setItem(LAST_AUTH_IDENTITY_KEY, session.identity);
    updateBadges();
    return { ok: true, lines: serverLines };
  }

  function getLastVisitedPath() {
    try {
      return String(sessionStorage.getItem(LAST_PATH_KEY) || "").trim();
    } catch (_) {
      return "";
    }
  }

  async function flexcaseAddToCartLoggedIn(merchandiseId, quantity, lineDetails = {}) {
    // UI-first: update local cart immediately and persist later.
    const current = readLocalLines();
    const next = dedupeByIdentity(current);
    const targetId = normalizeStorefrontVariantGid(merchandiseId) || String(merchandiseId || "").trim();
    const addQty = Math.max(1, Math.min(99, Number(quantity || 1)));
    const idx = next.findIndex((line) => {
      const id = String(line?.variantId || "").trim();
      return (
        id === targetId ||
        normalizeStorefrontVariantGid(id) === targetId ||
        id === normalizeStorefrontVariantGid(merchandiseId)
      );
    });
    if (idx >= 0) {
      const q = Math.max(1, Number(next[idx].quantity || 1));
      next[idx].quantity = Math.min(99, q + addQty);
      // Backfill missing display fields when existing line is sparse.
      if (!next[idx].productTitle && lineDetails.productTitle) {
        next[idx].productTitle = String(lineDetails.productTitle);
      }
      if (!next[idx].variantTitle && lineDetails.variantTitle) {
        next[idx].variantTitle = String(lineDetails.variantTitle);
      }
      if ((!next[idx].price || Number(next[idx].price) <= 0) && lineDetails.price != null) {
        next[idx].price = Number(lineDetails.price || 0);
      }
      if (!next[idx].currencyCode && lineDetails.currencyCode) {
        next[idx].currencyCode = String(lineDetails.currencyCode);
      }
      if (!next[idx].image && lineDetails.image) {
        next[idx].image = String(lineDetails.image);
      }
      if (!next[idx].productHandle && lineDetails.productHandle) {
        next[idx].productHandle = String(lineDetails.productHandle);
      }
    } else {
      const normalizedPrice = Number(lineDetails.price || 0);
      next.unshift({
        variantId: targetId,
        productHandle: String(lineDetails.productHandle || ""),
        productTitle: String(lineDetails.productTitle || "Product"),
        variantTitle: String(lineDetails.variantTitle || "Default"),
        quantity: addQty,
        price: Number.isFinite(normalizedPrice) ? normalizedPrice : 0,
        currencyCode: String(lineDetails.currencyCode || "MYR"),
        image: String(lineDetails.image || ""),
      });
    }
    writeLocalLines(next);
    void flexcasePushLocalCartToServer();
    updateBadges();
  }

  async function flexcaseClearServerCart() {
    const session = await getSessionState();
    if (!session.authenticated) return;
    try {
      await fetchApi("/api/cart/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    } catch (_) {
      /* ignore */
    }
  }

  async function runReplaceSyncNow(options = {}) {
    const session = await getSessionState();
    if (!session.authenticated) return false;
    const requestId = ++latestReplaceSyncRequestId;
    const local = dedupeByIdentity(readLocalLines());
    try {
      const r = await fetchApi("/api/cart/replace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lines: local }),
        keepalive: Boolean(options.keepalive),
        timeoutMs: 8000,
      });
      if (!r.ok) return false;
      // Ignore stale responses so older requests never overwrite newer edits.
      if (requestId !== latestReplaceSyncRequestId) return true;
      // Signed-in carts: treat the replace response as Shopify truth (same as a normal hosted cart).
      let data = {};
      try {
        data = await r.json();
      } catch (_) {
        data = {};
      }
      if (Array.isArray(data.lines)) {
        writeLocalLines(data.lines);
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  function flexcasePushLocalCartToServer() {
    if (SYNC_ONLY_ON_EXIT) return Promise.resolve(true);
    return new Promise((resolve) => {
      replaceSyncPendingResolvers.push(resolve);
      if (replaceSyncTimer) clearTimeout(replaceSyncTimer);
      replaceSyncTimer = setTimeout(() => {
        replaceSyncTimer = null;
        const resolvers = replaceSyncPendingResolvers.splice(0, replaceSyncPendingResolvers.length);
        replaceSyncChain = replaceSyncChain
          .catch(() => {})
          .then(() => runReplaceSyncNow())
          .then((ok) => {
            for (const done of resolvers) done(ok);
          });
      }, REPLACE_SYNC_DEBOUNCE_MS);
    });
  }

  function flexcaseFlushCartSync(options = {}) {
    if (!(options?.force) && SYNC_ONLY_ON_EXIT && !options?.keepalive) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      if (replaceSyncTimer) clearTimeout(replaceSyncTimer);
      replaceSyncTimer = null;
      const resolvers = replaceSyncPendingResolvers.splice(0, replaceSyncPendingResolvers.length);
      replaceSyncChain = replaceSyncChain
        .catch(() => {})
        .then(() => runReplaceSyncNow({ keepalive: Boolean(options?.keepalive) }))
        .then((ok) => {
          for (const done of resolvers) done(ok);
          resolve(ok);
        })
        .catch(() => resolve(false));
    });
  }

  function flexcaseOnLogoutClearMergeFlag() {
    try {
      sessionStorage.removeItem(MERGED_KEY);
    } catch (_) {}
  }

  window.FLEXCASE_CART_STORAGE_KEY = CART_KEY;
  window.flexcaseReadLocalCartLines = readLocalLines;
  window.flexcaseWriteLocalCartLines = writeLocalLines;
  window.flexcaseUpdateCartBadges = updateBadges;
  window.flexcaseSyncCartAfterAuth = flexcaseSyncCartAfterAuth;
  window.flexcaseRefreshCartFromServer = flexcaseRefreshCartFromServer;
  window.flexcaseHydrateLocalCartFromServer = flexcaseHydrateLocalCartFromServer;
  window.flexcaseHydrateLocalCartQuantitiesFromServer = flexcaseHydrateLocalCartQuantitiesFromServer;
  window.flexcaseGetLastVisitedPath = getLastVisitedPath;
  window.flexcaseAddToCartLoggedIn = flexcaseAddToCartLoggedIn;
  window.flexcaseClearServerCart = flexcaseClearServerCart;
  window.flexcasePushLocalCartToServer = flexcasePushLocalCartToServer;
  window.flexcaseFlushCartSync = flexcaseFlushCartSync;
  window.flexcaseOnLogoutClearMergeFlag = flexcaseOnLogoutClearMergeFlag;
  window.flexcaseMarkShopifyCheckoutHandoff = flexcaseMarkShopifyCheckoutHandoff;
  window.flexcaseReconcileAfterShopifyCheckoutReturn = flexcaseReconcileAfterShopifyCheckoutReturn;

  async function boot() {
    updateBadges();
    await flexcaseReconcileAfterShopifyCheckoutReturn().catch(() => {});
    const path = String(window.location.pathname || "").toLowerCase();
    const isCheckoutPage = path.endsWith("/checkout.html") || path === "/checkout.html";
    // Checkout runs local-first to avoid background hydration overwriting in-progress edits.
    if (!isCheckoutPage) {
      flexcaseSyncCartAfterAuth().catch(() => {});
    }
    window.addEventListener("pagehide", () => {
      try {
        sessionStorage.setItem(LAST_PATH_KEY, window.location.pathname || "");
      } catch (_) {
        /* ignore */
      }
      if (window.__flexcaseSkipExitCartFlush) {
        window.__flexcaseSkipExitCartFlush = false;
        return;
      }
      void flexcaseFlushCartSync({ keepalive: true, force: true });
    });
  }

  window.addEventListener("pageshow", (ev) => {
    if (!ev.persisted) return;
    void flexcaseReconcileAfterShopifyCheckoutReturn().catch(() => {});
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void boot().catch(() => {}));
  } else {
    void boot().catch(() => {});
  }
})();
