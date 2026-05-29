/**
 * Flexcase cart sync (v2 — clean architecture).
 *
 * Rules:
 *   • Guest cart lives in localStorage only. Never touches the server until checkout.
 *   • Signed-in cart truth lives on the Shopify Storefront Cart attached to the customer.
 *     localStorage is a read-through cache. Every mutation hits a dedicated endpoint
 *     that operates on absolute quantities (idempotent), and the response overwrites local.
 *   • The sign-in merge (`/api/cart/merge`) reconciles the browser cart with the Storefront
 *     cart once per (customerId, cartId): guest quantities win on overlapping variants so a
 *     preserved local cart cannot double server quantities after sign-out / sign-in.
 *   • Page loads do NOT merge. They only pull from the server.
 *   • A schema-version flag triggers a one-time automatic wipe so old buggy state is cleaned
 *     up on the user's next visit.
 */
(function () {
  const CART_KEY = "flexcase.local.cart";
  const SCHEMA_KEY = "flexcase.cart_schema_version";
  const SCHEMA_VERSION = "v3";
  const MERGED_PREFIX = "flexcase.merged_for_";
  const LAST_AUTH_IDENTITY_KEY = "flexcase.last.auth.identity";
  const LEGACY_MERGED_KEY = "flexcase_guest_cart_merged";
  const LAST_PATH_KEY = "flexcase.last.path";
  const CHECKOUT_HANDOFF_KEY = "flexcase.checkout_handoff_pending";
  const LAST_CHECKOUT_CART_KEY = "flexcase.last_checkout_cart";
  const LAST_CHECKOUT_CART_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const BADGE_QTY_CACHE_KEY = "flexcase.cart.badge_qty";

  function apiBase() {
    return (window.FLEXCASE_API_BASE || "https://api.flexcase.my").replace(/\/$/, "");
  }
  function apiUrl(p) {
    return `${apiBase()}${p}`;
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
    const timeoutMs = Number(options?.timeoutMs || 7000);
    const fetchOptions = { ...options };
    delete fetchOptions.timeoutMs;
    try {
      return await fetchWithTimeout(apiUrl(path), { credentials: "include", ...fetchOptions }, timeoutMs);
    } catch (_) {
      return fetchWithTimeout(path, { credentials: "include", ...fetchOptions }, Math.max(2500, Math.min(timeoutMs, 5000)));
    }
  }

  function normalizeStorefrontVariantGid(raw) {
    const s = String(raw ?? "").trim();
    if (!s) return "";
    if (s.startsWith("gid://shopify/ProductVariant/")) return s;
    const m = s.match(/ProductVariant\/(\d+)/i);
    if (m?.[1]) return `gid://shopify/ProductVariant/${m[1]}`;
    if (/^\d+$/.test(s)) return `gid://shopify/ProductVariant/${s}`;
    return "";
  }

  function variantKey(line) {
    return normalizeStorefrontVariantGid(line?.variantId) || String(line?.variantId || "").trim();
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
    const arr = Array.isArray(lines) ? lines : [];
    localStorage.setItem(CART_KEY, JSON.stringify(arr));
    try {
      window.dispatchEvent(new CustomEvent("flexcase-cart-updated"));
    } catch (_) {
      /* ignore */
    }
  }

  function cartTotalQty(lines) {
    return (lines || []).reduce((sum, l) => {
      const q = Number(l.quantity);
      if (Number.isFinite(q) && q >= 1) return sum + Math.min(99, q);
      return sum + 1;
    }, 0);
  }

  function readBadgeQtyFromStorage() {
    try {
      const cached = sessionStorage.getItem(BADGE_QTY_CACHE_KEY);
      if (cached !== null && cached !== "") {
        const n = parseInt(cached, 10);
        if (Number.isFinite(n) && n >= 0) return n;
      }
    } catch (_) {
      /* ignore */
    }
    return cartTotalQty(readLocalLines());
  }

  function persistBadgeQtyCache(qty) {
    try {
      if (qty > 0) {
        sessionStorage.setItem(BADGE_QTY_CACHE_KEY, String(qty));
      } else {
        sessionStorage.removeItem(BADGE_QTY_CACHE_KEY);
      }
    } catch (_) {
      /* ignore */
    }
  }

  function paintCartBadges(qty) {
    document.querySelectorAll(".cart-badge").forEach((el) => {
      el.textContent = String(qty);
      el.style.display = qty > 0 ? "" : "none";
    });
  }

  function updateBadges() {
    const qty = cartTotalQty(readLocalLines());
    persistBadgeQtyCache(qty);
    paintCartBadges(qty);
  }

  /** Paint cached cart qty as soon as navbar badges exist so page transitions do not flash empty. */
  function installEarlyCartBadgeHydration() {
    const qty = readBadgeQtyFromStorage();
    if (qty <= 0) return;

    const hydrate = () => paintCartBadges(qty);

    if (!document.documentElement) return;

    const observer = new MutationObserver(() => {
      if (document.querySelector(".cart-badge")) hydrate();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        hydrate();
        observer.disconnect();
      },
      { once: true }
    );
  }

  window.addEventListener("flexcase-cart-updated", updateBadges);

  /**
   * Reorder server response so the local cart presents newest-added on top while
   * existing lines keep their previous position (quantity changes do not reshuffle).
   *
   *   • `justAddedVariantId` (optional): force that variant to the top.
   *   • Items new to the server (e.g. transform-injected bundles, sync from another
   *     device) go above previously-known items.
   *   • Previously-known items keep their previous local order.
   *
   * Also preserves UI metadata (title/image/handle) when the server response is sparse.
   */
  function reconcileServerLines(serverLines, justAddedVariantId = "") {
    const local = readLocalLines();
    const localByKey = new Map();
    const localOrder = new Map();
    local.forEach((l, idx) => {
      const k = variantKey(l);
      if (!k) return;
      localByKey.set(k, l);
      localOrder.set(k, idx);
    });

    const justAddedKey = justAddedVariantId
      ? normalizeStorefrontVariantGid(justAddedVariantId) || String(justAddedVariantId).trim()
      : "";

    const hydrated = (serverLines || []).map((line, srvIdx) => {
      const key = variantKey(line);
      const cached = localByKey.get(key) || {};
      return {
        line: {
          ...cached,
          ...line,
          variantId: key,
          productHandle: line.productHandle || cached.productHandle || "",
          productTitle: line.productTitle || cached.productTitle || "",
          variantTitle: line.variantTitle || cached.variantTitle || "",
          image: line.image || cached.image || "",
          currencyCode: line.currencyCode || cached.currencyCode || "MYR",
        },
        key,
        srvIdx,
      };
    });

    hydrated.sort((a, b) => {
      if (a.key && a.key === justAddedKey) return -1;
      if (b.key && b.key === justAddedKey) return 1;
      const aKnown = localOrder.has(a.key);
      const bKnown = localOrder.has(b.key);
      if (aKnown && bKnown) return localOrder.get(a.key) - localOrder.get(b.key);
      if (aKnown && !bKnown) return 1;
      if (!aKnown && bKnown) return -1;
      return a.srvIdx - b.srvIdx;
    });

    return hydrated.map((entry) => entry.line);
  }

  // Backwards-compatible alias — older callers passed only server lines.
  function preserveLocalDetails(serverLines) {
    return reconcileServerLines(serverLines, "");
  }

  function sessionIdentity(payload) {
    const id = String(payload?.customer?.id || "").trim();
    if (id) return `id:${id}`;
    const email = String(payload?.customer?.email || "").trim().toLowerCase();
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

  function customerIdFromIdentity(identity) {
    if (!identity) return "";
    if (identity.startsWith("id:")) return identity.slice(3);
    return identity;
  }

  function getMergeStamp(customerId) {
    if (!customerId) return "";
    try {
      return String(localStorage.getItem(MERGED_PREFIX + customerId) || "");
    } catch (_) {
      return "";
    }
  }

  function setMergeStamp(customerId, cartId) {
    if (!customerId || !cartId) return;
    try {
      localStorage.setItem(MERGED_PREFIX + customerId, String(cartId));
    } catch (_) {
      /* ignore */
    }
  }

  function clearAllMergeStamps() {
    try {
      const toDelete = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(MERGED_PREFIX)) toDelete.push(k);
      }
      toDelete.forEach((k) => localStorage.removeItem(k));
    } catch (_) {
      /* ignore */
    }
  }

  async function fetchServerCart() {
    const r = await fetchApi("/api/cart").catch(() => null);
    if (!r) return null;
    if (r.status === 401) return null;
    if (!r.ok) return null;
    const j = await r.json().catch(() => ({}));
    return {
      cartId: String(j?.cartId || "").trim(),
      lines: Array.isArray(j?.lines) ? j.lines : [],
    };
  }

  async function pullServerCart() {
    const session = await getSessionState();
    if (!session.authenticated) return null;
    const data = await fetchServerCart();
    if (!data) return null;
    writeLocalLines(preserveLocalDetails(data.lines));
    updateBadges();
    if (session.identity) {
      try {
        sessionStorage.setItem(LAST_AUTH_IDENTITY_KEY, session.identity);
      } catch (_) {
        /* ignore */
      }
    }
    return { ...data, identity: session.identity };
  }

  // --- Core mutators -------------------------------------------------------

  async function flexcaseAddLine(variantId, quantity, lineDetails = {}) {
    const vid = normalizeStorefrontVariantGid(variantId);
    if (!vid) return false;
    const q = Math.max(1, Math.min(99, Math.floor(Number(quantity || 1))));
    const session = await getSessionState();

    if (session.authenticated) {
      try {
        const r = await fetchApi("/api/cart/add", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ merchandiseId: vid, quantity: q }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          throw new Error(String(j?.error || "Could not add to cart. Try again."));
        }
        if (Array.isArray(j.lines)) {
          writeLocalLines(reconcileServerLines(j.lines, vid));
        }
        updateBadges();
        return true;
      } catch (error) {
        if (error instanceof Error) throw error;
        throw new Error("Could not add to cart. Try again.");
      }
    }

    const lines = readLocalLines();
    const idx = lines.findIndex((l) => variantKey(l) === vid);
    if (idx >= 0) {
      const prev = Math.max(1, Number(lines[idx].quantity || 1));
      lines[idx] = { ...lines[idx], variantId: vid, quantity: Math.min(99, prev + q) };
    } else {
      const price = Number(lineDetails?.price || 0);
      lines.unshift({
        variantId: vid,
        productHandle: String(lineDetails?.productHandle || ""),
        productTitle: String(lineDetails?.productTitle || "Product"),
        variantTitle: String(lineDetails?.variantTitle || "Default"),
        quantity: q,
        price: Number.isFinite(price) ? price : 0,
        currencyCode: String(lineDetails?.currencyCode || "MYR"),
        image: String(lineDetails?.image || ""),
      });
    }
    writeLocalLines(lines);
    updateBadges();
    return true;
  }

  async function flexcaseSetLineQuantity(variantId, quantity) {
    const vid = normalizeStorefrontVariantGid(variantId) || String(variantId || "").trim();
    if (!vid) return false;
    const q = Math.max(0, Math.min(99, Math.floor(Number(quantity || 0))));
    const session = await getSessionState();

    if (session.authenticated) {
      try {
        const r = await fetchApi("/api/cart/set-quantity", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ variantId: vid, quantity: q }),
        });
        if (!r.ok) return false;
        const j = await r.json().catch(() => ({}));
        if (Array.isArray(j.lines)) {
          writeLocalLines(preserveLocalDetails(j.lines));
        }
        updateBadges();
        return true;
      } catch (_) {
        return false;
      }
    }

    const lines = readLocalLines();
    const idx = lines.findIndex((l) => variantKey(l) === vid);
    if (q === 0) {
      if (idx >= 0) lines.splice(idx, 1);
    } else if (idx >= 0) {
      lines[idx] = { ...lines[idx], variantId: vid, quantity: q };
    }
    writeLocalLines(lines);
    updateBadges();
    return true;
  }

  async function flexcaseRemoveLine(variantId) {
    return flexcaseSetLineQuantity(variantId, 0);
  }

  async function flexcaseClearServerCart() {
    const session = await getSessionState();
    if (!session.authenticated) return false;
    try {
      const r = await fetchApi("/api/cart/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      return r.ok;
    } catch (_) {
      return false;
    }
  }

  async function flexcaseResetCart() {
    try {
      await flexcaseClearServerCart();
    } catch (_) {
      /* ignore */
    }
    writeLocalLines([]);
    clearAllMergeStamps();
    try {
      localStorage.removeItem(LAST_CHECKOUT_CART_KEY);
    } catch (_) {
      /* ignore */
    }
    try {
      sessionStorage.removeItem(LEGACY_MERGED_KEY);
      sessionStorage.removeItem(CHECKOUT_HANDOFF_KEY);
      sessionStorage.removeItem(LAST_AUTH_IDENTITY_KEY);
    } catch (_) {
      /* ignore */
    }
    updateBadges();
  }

  // --- One-time schema migration / wipe ------------------------------------

  async function maybeRunSchemaMigration() {
    let v = "";
    try {
      v = String(localStorage.getItem(SCHEMA_KEY) || "");
    } catch (_) {
      v = "";
    }
    if (v === SCHEMA_VERSION) return false;
    try {
      await flexcaseResetCart();
    } finally {
      try {
        localStorage.setItem(SCHEMA_KEY, SCHEMA_VERSION);
      } catch (_) {
        /* ignore */
      }
    }
    return true;
  }

  // --- Sign-in merge (runs at most once per customer+cart pair) ------------

  async function performSignInMergeIfNeeded(customerId, serverCartId) {
    if (!customerId || !serverCartId) return false;
    if (getMergeStamp(customerId) === serverCartId) return false;
    const local = readLocalLines();
    const guestLines = [];
    for (const l of local) {
      const vid = variantKey(l);
      if (!vid.startsWith("gid://shopify/ProductVariant/")) continue;
      const q = Math.max(1, Math.min(99, Number(l.quantity || 1)));
      guestLines.push({ variantId: vid, quantity: q });
    }
    if (!guestLines.length) {
      setMergeStamp(customerId, serverCartId);
      return false;
    }
    try {
      const r = await fetchApi("/api/cart/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lines: guestLines }),
      });
      if (!r.ok) return false;
    } catch (_) {
      return false;
    }
    setMergeStamp(customerId, serverCartId);
    return true;
  }

  async function flexcaseSyncCartAfterAuth() {
    const session = await getSessionState();
    if (!session.authenticated) {
      updateBadges();
      return false;
    }
    const customerId = customerIdFromIdentity(session.identity);
    const priorIdentity = String(sessionStorage.getItem(LAST_AUTH_IDENTITY_KEY) || "").trim();
    const accountSwitched = Boolean(priorIdentity && session.identity && priorIdentity !== session.identity);
    if (accountSwitched) clearAllMergeStamps();

    const data = await fetchServerCart();
    if (!data) {
      updateBadges();
      return false;
    }
    const merged = await performSignInMergeIfNeeded(customerId, data.cartId);
    if (merged) {
      const refreshed = await fetchServerCart();
      if (refreshed) writeLocalLines(preserveLocalDetails(refreshed.lines));
    } else {
      writeLocalLines(preserveLocalDetails(data.lines));
    }
    try {
      sessionStorage.setItem(LAST_AUTH_IDENTITY_KEY, session.identity || "");
    } catch (_) {
      /* ignore */
    }
    updateBadges();
    return true;
  }

  // --- Backwards-compatible wrappers (legacy callers) ----------------------

  async function flexcaseRefreshCartFromServer() {
    return Boolean(await pullServerCart());
  }
  async function flexcaseHydrateLocalCartFromServer() {
    return Boolean(await pullServerCart());
  }
  async function flexcaseHydrateLocalCartQuantitiesFromServer() {
    const r = await pullServerCart();
    return { ok: Boolean(r), lines: r?.lines || [] };
  }
  async function flexcaseMergeServerCart() {
    return Boolean(await pullServerCart());
  }
  async function flexcaseAddToCartLoggedIn(merchandiseId, quantity, details) {
    return flexcaseAddLine(merchandiseId, quantity, details);
  }
  function flexcasePushLocalCartToServer() {
    return Promise.resolve(true);
  }
  function flexcaseFlushCartSync() {
    return Promise.resolve(true);
  }

  function flexcaseOnLogoutClearMergeFlag() {
    clearAllMergeStamps();
    try {
      sessionStorage.removeItem(LEGACY_MERGED_KEY);
      sessionStorage.removeItem(LAST_AUTH_IDENTITY_KEY);
    } catch (_) {
      /* ignore */
    }
  }

  // --- Checkout handoff / order-complete machinery (unchanged behavior) ----

  function computeLocalCartSignature() {
    try {
      return JSON.stringify(readLocalLines());
    } catch (_) {
      return "";
    }
  }

  function flexcaseMarkShopifyCheckoutHandoff(cartId) {
    try {
      sessionStorage.setItem(CHECKOUT_HANDOFF_KEY, "1");
    } catch (_) {
      /* ignore */
    }
    const trimmed = String(cartId || "").trim();
    if (trimmed && trimmed.startsWith("gid://shopify/Cart/")) {
      try {
        localStorage.setItem(
          LAST_CHECKOUT_CART_KEY,
          JSON.stringify({ cartId: trimmed, ts: Date.now(), signature: computeLocalCartSignature() })
        );
      } catch (_) {
        /* ignore */
      }
    }
  }

  function readLastCheckoutCartTracker() {
    try {
      const raw = localStorage.getItem(LAST_CHECKOUT_CART_KEY) || "";
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const cartId = String(parsed?.cartId || "").trim();
      const ts = Number(parsed?.ts || 0);
      const signature = typeof parsed?.signature === "string" ? parsed.signature : "";
      if (!cartId.startsWith("gid://shopify/Cart/")) return null;
      return { cartId, ts: Number.isFinite(ts) ? ts : 0, signature };
    } catch (_) {
      return null;
    }
  }

  function clearLastCheckoutCartTracker() {
    try {
      localStorage.removeItem(LAST_CHECKOUT_CART_KEY);
    } catch (_) {
      /* ignore */
    }
  }

  async function flexcaseCheckLastCheckoutCartStatus() {
    const tracker = readLastCheckoutCartTracker();
    if (!tracker) return false;
    if (tracker.ts && Date.now() - tracker.ts > LAST_CHECKOUT_CART_TTL_MS) {
      clearLastCheckoutCartTracker();
      return false;
    }
    if (tracker.signature && tracker.signature !== computeLocalCartSignature()) {
      clearLastCheckoutCartTracker();
      return false;
    }
    const path = `/api/cart/storefront-status?cartId=${encodeURIComponent(tracker.cartId)}`;
    let payload = null;
    try {
      const r = await fetchApi(path);
      if (!r.ok) return false;
      payload = await r.json();
    } catch (_) {
      return false;
    }
    if (!payload || typeof payload !== "object") return false;
    if (payload.completed === true) {
      writeLocalLines([]);
      updateBadges();
      clearLastCheckoutCartTracker();
      try {
        sessionStorage.removeItem(CHECKOUT_HANDOFF_KEY);
      } catch (_) {
        /* ignore */
      }
      try {
        const session = await getSessionState();
        if (session.authenticated) await flexcaseClearServerCart().catch(() => {});
      } catch (_) {
        /* ignore */
      }
      return true;
    }
    return false;
  }

  function detectOrderCompleteSignal() {
    try {
      const path = String(window.location.pathname || "").toLowerCase();
      if (path.endsWith("/thank-you.html") || path === "/thank-you.html") return true;
      const params = new URLSearchParams(window.location.search || "");
      if (params.get("order_complete") === "1") return true;
      if (params.get("flexcase_thanks") === "1") return true;
      return false;
    } catch (_) {
      return false;
    }
  }

  function stripOrderCompleteQueryParams() {
    try {
      const url = new URL(window.location.href);
      let changed = false;
      for (const key of ["order_complete", "flexcase_thanks"]) {
        if (url.searchParams.has(key)) {
          url.searchParams.delete(key);
          changed = true;
        }
      }
      if (changed) {
        const next = url.pathname + (url.searchParams.toString() ? `?${url.searchParams}` : "") + url.hash;
        window.history.replaceState({}, document.title, next);
      }
    } catch (_) {
      /* ignore */
    }
  }

  async function flexcaseHandleOrderCompleteUrl() {
    if (!detectOrderCompleteSignal()) return false;
    try {
      sessionStorage.removeItem(CHECKOUT_HANDOFF_KEY);
    } catch (_) {
      /* ignore */
    }
    clearLastCheckoutCartTracker();
    writeLocalLines([]);
    updateBadges();
    stripOrderCompleteQueryParams();
    try {
      const session = await getSessionState();
      if (session.authenticated) {
        await flexcaseClearServerCart().catch(() => {});
        clearAllMergeStamps();
      }
    } catch (_) {
      /* ignore */
    }
    return true;
  }

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
    const data = await fetchServerCart();
    if (!data) return;
    if (data.lines.length === 0) {
      writeLocalLines([]);
    } else {
      writeLocalLines(preserveLocalDetails(data.lines));
    }
    updateBadges();
  }

  // --- Public surface ------------------------------------------------------

  window.FLEXCASE_CART_STORAGE_KEY = CART_KEY;
  window.FLEXCASE_CART_SCHEMA_VERSION = SCHEMA_VERSION;

  window.flexcaseReadLocalCartLines = readLocalLines;
  window.flexcaseWriteLocalCartLines = writeLocalLines;
  window.flexcaseUpdateCartBadges = updateBadges;

  window.flexcaseAddLine = flexcaseAddLine;
  window.flexcaseSetLineQuantity = flexcaseSetLineQuantity;
  window.flexcaseRemoveLine = flexcaseRemoveLine;
  window.flexcaseResetCart = flexcaseResetCart;

  window.flexcaseSyncCartAfterAuth = flexcaseSyncCartAfterAuth;
  window.flexcaseRefreshCartFromServer = flexcaseRefreshCartFromServer;
  window.flexcaseHydrateLocalCartFromServer = flexcaseHydrateLocalCartFromServer;
  window.flexcaseHydrateLocalCartQuantitiesFromServer = flexcaseHydrateLocalCartQuantitiesFromServer;
  window.flexcaseMergeServerCart = flexcaseMergeServerCart;

  window.flexcaseAddToCartLoggedIn = flexcaseAddToCartLoggedIn;
  window.flexcasePushLocalCartToServer = flexcasePushLocalCartToServer;
  window.flexcaseFlushCartSync = flexcaseFlushCartSync;
  window.flexcaseClearServerCart = flexcaseClearServerCart;
  window.flexcaseOnLogoutClearMergeFlag = flexcaseOnLogoutClearMergeFlag;

  window.flexcaseMarkShopifyCheckoutHandoff = flexcaseMarkShopifyCheckoutHandoff;
  window.flexcaseReconcileAfterShopifyCheckoutReturn = flexcaseReconcileAfterShopifyCheckoutReturn;
  window.flexcaseHandleOrderCompleteUrl = flexcaseHandleOrderCompleteUrl;
  window.flexcaseCheckLastCheckoutCartStatus = flexcaseCheckLastCheckoutCartStatus;
  window.flexcaseGetLastVisitedPath = () => {
    try {
      return String(sessionStorage.getItem(LAST_PATH_KEY) || "").trim();
    } catch (_) {
      return "";
    }
  };

  window.flexcaseEnsureCartReady = () => cartBootPromise || Promise.resolve();

  // --- Boot ---------------------------------------------------------------

  let cartBootPromise = null;

  async function boot() {
    updateBadges();
    await maybeRunSchemaMigration().catch(() => {});
    updateBadges();

    const orderCompleted = await flexcaseHandleOrderCompleteUrl().catch(() => false);
    if (!orderCompleted) {
      const clearedByStatus = await flexcaseCheckLastCheckoutCartStatus().catch(() => false);
      if (!clearedByStatus) {
        await flexcaseReconcileAfterShopifyCheckoutReturn().catch(() => {});
      }
    }

    await flexcaseSyncCartAfterAuth().catch(() => {});

    window.addEventListener("pagehide", () => {
      try {
        sessionStorage.setItem(LAST_PATH_KEY, window.location.pathname || "");
      } catch (_) {
        /* ignore */
      }
    });
  }

  window.addEventListener("pageshow", (ev) => {
    if (!ev.persisted) return;
    void (async () => {
      const orderCompleted = await flexcaseHandleOrderCompleteUrl().catch(() => false);
      if (orderCompleted) return;
      const cleared = await flexcaseCheckLastCheckoutCartStatus().catch(() => false);
      if (cleared) return;
      await flexcaseReconcileAfterShopifyCheckoutReturn().catch(() => {});
    })();
  });

  installEarlyCartBadgeHydration();
  cartBootPromise = boot().catch(() => {});
})();
