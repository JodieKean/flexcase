(function () {
  var PERSIST_HEAD =
    'meta[charset],meta[name="viewport"],' +
    'link[rel="icon"],link[rel="apple-touch-icon"],' +
    'link[href="assets/navbar.css"],link[href="assets/layout.css"],' +
    'script[src="assets/flexcase-cart-sync.js"],' +
    'script[src="assets/navbar-scroll.js"],' +
    'script[src="assets/site-nav.js"]';

  function isPersistedHeadNode(node) {
    return node.matches && node.matches(PERSIST_HEAD);
  }

  function isNavigableUrl(url) {
    if (url.origin !== location.origin) return false;
    var path = url.pathname;
    return path === "/" || /\.html?$/i.test(path);
  }

  function shouldIntercept(anchor, event) {
    if (!anchor || !anchor.href) return false;
    if (anchor.target === "_blank" || anchor.hasAttribute("download")) return false;
    if (anchor.dataset.flexcaseNav === "off") return false;
    if (event.defaultPrevented || event.button !== 0) return false;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
    var url = new URL(anchor.href, location.href);
    if (!isNavigableUrl(url)) return false;
    if (
      url.pathname === location.pathname &&
      url.search === location.search &&
      url.hash
    ) {
      return false;
    }
    return true;
  }

  function syncNavbarState(sourceDoc) {
    var currentHeader = document.querySelector(".site-header");
    var nextHeader = sourceDoc.querySelector(".site-header");
    if (!currentHeader || !nextHeader) return;

    currentHeader.querySelectorAll("[aria-current]").forEach(function (el) {
      el.removeAttribute("aria-current");
    });

    nextHeader.querySelectorAll("[aria-current]").forEach(function (el) {
      var href = el.getAttribute("href");
      if (!href) return;
      var match = currentHeader.querySelector('[href="' + href + '"]');
      if (!match) return;
      var value = el.getAttribute("aria-current");
      if (value) match.setAttribute("aria-current", value);
      var label = el.getAttribute("aria-label");
      if (label) match.setAttribute("aria-label", label);
    });
  }

  function mergeHead(sourceDoc) {
    Array.from(document.head.children).forEach(function (node) {
      if (node.matches("title")) {
        node.remove();
        return;
      }
      if (isPersistedHeadNode(node)) return;
      if (
        node.matches("style") ||
        node.matches('link[rel="stylesheet"]') ||
        node.matches('link[rel="preload"]') ||
        node.matches("script")
      ) {
        node.remove();
      }
    });

    Array.from(sourceDoc.head.children).forEach(function (node) {
      if (isPersistedHeadNode(node)) return;
      if (
        node.matches("title") ||
        node.matches("style") ||
        node.matches('link[rel="stylesheet"]') ||
        node.matches('link[rel="preload"]') ||
        node.matches("script")
      ) {
        document.head.appendChild(node.cloneNode(true));
      }
    });

    document.title = sourceDoc.title;
  }

  function runScripts(root) {
    root.querySelectorAll("script").forEach(function (oldScript) {
      var script = document.createElement("script");
      Array.from(oldScript.attributes).forEach(function (attr) {
        script.setAttribute(attr.name, attr.value);
      });
      script.textContent = oldScript.textContent;
      oldScript.replaceWith(script);
    });
  }

  function swapPage(sourceDoc) {
    var header = document.querySelector(".site-header");
    if (!header) {
      location.href = sourceDoc.URL || location.href;
      return;
    }

    mergeHead(sourceDoc);
    syncNavbarState(sourceDoc);

    Array.from(document.body.children).forEach(function (child) {
      if (child === header) return;
      child.remove();
    });

    Array.from(sourceDoc.body.children).forEach(function (child) {
      if (child.matches(".site-header")) return;
      document.body.appendChild(child.cloneNode(true));
    });

    runScripts(document.body);
    document.dispatchEvent(new Event("flexcase:navigate"));
    window.dispatchEvent(new Event("resize"));
  }

  var navigating = false;

  function navigate(url, push) {
    if (navigating) return;
    navigating = true;

    fetch(url, { credentials: "same-origin" })
      .then(function (res) {
        if (!res.ok) throw new Error("navigation failed");
        return res.text();
      })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, "text/html");
        var apply = function () {
          swapPage(doc);
          if (push) history.pushState({ flexcase: true }, "", url);
          var targetUrl = new URL(url, location.href);
          if (targetUrl.hash) {
            requestAnimationFrame(function () {
              var target = document.querySelector(targetUrl.hash);
              if (target) target.scrollIntoView();
            });
          } else {
            window.scrollTo(0, 0);
          }
        };
        if (document.startViewTransition) {
          return document.startViewTransition(apply).finished;
        }
        apply();
      })
      .catch(function () {
        location.href = url;
      })
      .finally(function () {
        navigating = false;
      });
  }

  document.addEventListener("click", function (event) {
    var anchor = event.target.closest("a[href]");
    if (!shouldIntercept(anchor, event)) return;
    var url = new URL(anchor.href, location.href).href;
    if (
      url === location.href ||
      (new URL(url).pathname === location.pathname &&
        new URL(url).search === location.search &&
        !new URL(url).hash)
    ) {
      return;
    }
    event.preventDefault();
    navigate(url, true);
  });

  window.addEventListener("popstate", function () {
    navigate(location.href, false);
  });
})();
