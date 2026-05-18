(function () {
  const nav = document.querySelector(".site-navbar");
  if (!nav) return;

  const mobileQuery = window.matchMedia("(max-width: 980px)");
  let lastScrollY = window.scrollY;
  let ticking = false;

  function setNavbarHidden(hidden) {
    nav.classList.toggle("is-hidden", hidden);
    document.body.classList.toggle("navbar-hidden", hidden);
  }

  function updateNavbarVisibility() {
    ticking = false;
    if (!mobileQuery.matches) {
      setNavbarHidden(false);
      lastScrollY = window.scrollY;
      return;
    }

    const currentY = window.scrollY;
    if (currentY <= 8) {
      setNavbarHidden(false);
    } else if (currentY > lastScrollY + 6) {
      setNavbarHidden(true);
    } else if (currentY < lastScrollY - 6) {
      setNavbarHidden(false);
    }
    lastScrollY = currentY;
  }

  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(updateNavbarVisibility);
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  mobileQuery.addEventListener("change", () => {
    lastScrollY = window.scrollY;
    setNavbarHidden(false);
    updateNavbarVisibility();
  });

  updateNavbarVisibility();
})();
