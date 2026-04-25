(function () {
  const CART_KEY = "flexcase.local.cart";
  const MERGED_KEY = "flexcase_guest_cart_merged";
  let latestReplaceSyncRequestId = 0;
  const REPLACE_SYNC_DEBOUNCE_MS = 280;
  let replaceSyncTimer = null;
  let replaceSyncPendingResolvers = [];
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

  async function isSessionAuthenticated() {
    try {
      const r = await fetchApi("/api/customer/session");
      const j = await r.json();
      return Boolean(j?.authenticated);
    } catch (_) {
      return false;
    }
  }

  async function pullServerCartToLocal() {
    const r = await fetchApi("/api/cart");
    if (r.status === 401) return false;
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return false;
    const current = readLocalLines();
    writeLocalLines(mergeWithStableOrder(j.lines || [], current, false));
    return true;
  }

  async function mergeGuestThenPull() {
    if (sessionStorage.getItem(MERGED_KEY)) {
      await pullServerCartToLocal();
      return;
    }
    const local = readLocalLines();
    if (local.length) {
      try {
        const r = await fetchApi("/api/cart/merge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lines: local }),
        });
        if (r.ok) {
          const j = await r.json();
          writeLocalLines(mergeWithStableOrder(j.lines || [], local, false));
        } else {
          const t = await r.text();
          let p = {};
          try {
            p = JSON.parse(t);
          } catch (_) {}
          console.warn(p.error || "Cart merge failed", t);
        }
      } catch (e) {
        console.warn(e);
      }
    } else {
      await pullServerCartToLocal();
    }
    sessionStorage.setItem(MERGED_KEY, "1");
  }

  async function flexcaseSyncCartAfterAuth() {
    if (!(await isSessionAuthenticated())) return;
    await mergeGuestThenPull();
    updateBadges();
  }

  async function flexcaseRefreshCartFromServer() {
    if (!(await isSessionAuthenticated())) return false;
    const ok = await pullServerCartToLocal();
    updateBadges();
    return ok;
  }

  async function flexcaseAddToCartLoggedIn(merchandiseId, quantity) {
    let r;
    try {
      r = await fetchApi("/api/cart/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ merchandiseId, quantity }),
        timeoutMs: 8000,
      });
    } catch (error) {
      const msg = String(error?.message || "").toLowerCase();
      if (msg.includes("abort")) {
        throw new Error("Cart API timeout");
      }
      throw new Error("Cart API unavailable");
    }
    const raw = await r.text();
    let j = {};
    try {
      j = raw ? JSON.parse(raw) : {};
    } catch (_) {}
    if (!r.ok) {
      const reason = j.error || `Add failed (${r.status})`;
      throw new Error(reason);
    }
    const current = readLocalLines();
    writeLocalLines(mergeWithStableOrder(j.lines || [], current, true));
    updateBadges();
  }

  async function flexcaseClearServerCart() {
    if (!(await isSessionAuthenticated())) return;
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

  async function runReplaceSyncNow() {
    if (!(await isSessionAuthenticated())) return false;
    const requestId = ++latestReplaceSyncRequestId;
    const local = readLocalLines();
    try {
      const r = await fetchApi("/api/cart/replace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lines: local }),
        timeoutMs: 8000,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return false;
      // Ignore stale responses so older requests never overwrite newer edits.
      if (requestId !== latestReplaceSyncRequestId) return true;
      const localQty = cartTotalQty(local);
      const serverQty = cartTotalQty(j.lines || []);
      // Keep optimistic local lines authoritative for UI stability.
      // Only accept server payload if totals match local intent.
      if (localQty === serverQty) {
        writeLocalLines(mergeWithStableOrder(j.lines || [], local, false));
      } else {
        writeLocalLines(local);
      }
      updateBadges();
      return true;
    } catch (_) {
      return false;
    }
  }

  function flexcasePushLocalCartToServer() {
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
  window.flexcaseAddToCartLoggedIn = flexcaseAddToCartLoggedIn;
  window.flexcaseClearServerCart = flexcaseClearServerCart;
  window.flexcasePushLocalCartToServer = flexcasePushLocalCartToServer;
  window.flexcaseOnLogoutClearMergeFlag = flexcaseOnLogoutClearMergeFlag;

  function boot() {
    updateBadges();
    flexcaseSyncCartAfterAuth().catch(() => {});
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
