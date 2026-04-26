(function () {
  const CART_KEY = "flexcase.local.cart";
  const MERGED_KEY = "flexcase_guest_cart_merged";
  const LAST_PATH_KEY = "flexcase.last.path";
  const LAST_AUTH_IDENTITY_KEY = "flexcase.last.auth.identity";
  let latestReplaceSyncRequestId = 0;
  const REPLACE_SYNC_DEBOUNCE_MS = Number(window.FLEXCASE_CART_SYNC_DEBOUNCE_MS || 800);
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

  function lineIdentity(line) {
    const variantId = String(line?.variantId || "").trim();
    if (variantId) return `variant:${variantId}`;
    const fallback = `${String(line?.productTitle || "").trim()}|${String(line?.variantTitle || "").trim()}`;
    return `title:${fallback}`;
  }

  function dedupeByIdentity(lines) {
    const out = [];
    const seen = new Set();
    for (const line of Array.isArray(lines) ? lines : []) {
      const key = lineIdentity(line);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(line);
    }
    return out;
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

  async function pullServerCartToLocal() {
    const r = await fetchApi("/api/cart");
    if (r.status === 401) return false;
    if (!r.ok) return false;
    const j = await r.json().catch(() => ({}));
    const lines = Array.isArray(j?.lines) ? j.lines : [];
    // Checkout can set this flag while user is actively editing quantity,
    // so late hydration responses never stomp local optimistic state.
    if (window.__flexcaseSkipHydrateWrite) return true;
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
      void runReplaceSyncNow().catch(() => false);
    }
    if (currentIdentity) sessionStorage.setItem(LAST_AUTH_IDENTITY_KEY, currentIdentity);
    updateBadges();
  }

  async function flexcaseRefreshCartFromServer() {
    // Explicit refresh should hydrate from Shopify truth.
    const session = await getSessionState();
    if (!session.authenticated) return false;
    const ok = await pullServerCartToLocal().catch(() => false);
    if (ok && session.identity) sessionStorage.setItem(LAST_AUTH_IDENTITY_KEY, session.identity);
    updateBadges();
    return ok;
  }

  async function flexcaseHydrateLocalCartFromServer() {
    const session = await getSessionState();
    if (!session.authenticated) return false;
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
      const key = String(line?.variantId || "").trim();
      if (!key || !byVariantId.has(key)) return line;
      return { ...line, quantity: byVariantId.get(key) };
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
    const targetId = String(merchandiseId || "").trim();
    const addQty = Math.max(1, Math.min(99, Number(quantity || 1)));
    const idx = next.findIndex((line) => String(line?.variantId || "").trim() === targetId);
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
        currencyCode: String(lineDetails.currencyCode || "USD"),
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
    const local = readLocalLines();
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
      // Push-only path: never rewrite local state from sync responses.
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

  function boot() {
    updateBadges();
    flexcaseSyncCartAfterAuth().catch(() => {});
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

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
