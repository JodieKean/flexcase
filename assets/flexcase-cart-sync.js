(function () {
  const CART_KEY = "flexcase.local.cart";
  const MERGED_KEY = "flexcase_guest_cart_merged";

  function apiBase() {
    return (window.FLEXCASE_API_BASE || "https://api.flexcase.my").replace(/\/$/, "");
  }

  function apiUrl(p) {
    return `${apiBase()}${p}`;
  }

  function localApiUrl(p) {
    return p;
  }

  async function fetchApi(path, options = {}) {
    try {
      return await fetch(apiUrl(path), { credentials: "include", ...options });
    } catch (_) {
      return fetch(localApiUrl(path), { credentials: "include", ...options });
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

  function cartTotalQty(lines) {
    return (lines || []).reduce((s, l) => s + Number(l.quantity || 0), 0);
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
    writeLocalLines(j.lines || []);
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
          writeLocalLines(j.lines || []);
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
    const r = await fetchApi("/api/cart/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ merchandiseId, quantity }),
    });
    const raw = await r.text();
    let j = {};
    try {
      j = raw ? JSON.parse(raw) : {};
    } catch (_) {}
    if (!r.ok) throw new Error(j.error || "Unable to add to cart.");
    writeLocalLines(j.lines || []);
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
