(function () {
  // Use full page loads for all in-site navigation. Soft swaps (keeping the header in
  // the DOM) broke page init scripts on account, checkout, home, and product pages.

  document.addEventListener("click", function (event) {
    var anchor = event.target.closest("a[href]");
    if (!anchor || !anchor.href) return;
    if (event.button !== 0 || event.defaultPrevented) return;
    if (anchor.target === "_blank" || anchor.hasAttribute("download")) return;

    var url = new URL(anchor.href, location.href);
    var here = new URL(location.href);
    if (url.origin !== here.origin) return;

    if (
      url.pathname === here.pathname &&
      url.search === here.search &&
      !url.hash &&
      url.href === here.href
    ) {
      event.preventDefault();
      location.reload();
    }
  });
})();
