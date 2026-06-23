(function () {
  const CONFIG_SELECTOR = ".student-pricing-config[data-endpoint][data-customer-id]";
  const PRICE_SELECTOR = [
    "[data-product-price]",
    ".price__current .money",
    ".price-item--regular",
    ".price-item",
    ".product-price",
    ".price",
    "[class*='price']"
  ].join(",");
  const CARD_ROOT_SELECTOR = [
    "[data-product-card]",
    "[data-card-wrapper]",
    ".card-wrapper",
    ".grid__item",
    ".product-item",
    ".product-card",
    "product-card",
    "li",
    "article"
  ].join(",");
  const CART_LINE_SELECTOR = [
    "[data-cart-item]",
    ".cart-item",
    ".cart__item",
    ".line-item",
    "tr",
    "li"
  ].join(",");
  const LIMITED_OFFER_HANDLE = "iphone-17e";
  const LIMITED_OFFER_TITLE = "13-inch macbook neo";
  const LIMITED_OFFER_STORAGE = "256gb no touch id";
  const PROTECTED_COLLECTION_HANDLES = new Set(["bundle", "all-bundles"]);
  const PROTECTED_PRODUCT_HANDLES = new Set(["primary-years-bundle"]);

  let scanTimer = 0;
  let observer = null;
  let requestToken = 0;

  function getConfig() {
    return document.querySelector(CONFIG_SELECTOR);
  }

  function getShopDomain(config) {
    const dataShop = String((config && config.dataset && config.dataset.shop) || "").trim();
    if (dataShop) return dataShop;

    const globalShop =
      window.Shopify &&
      typeof window.Shopify.shop === "string"
        ? String(window.Shopify.shop).trim()
        : "";

    return globalShop;
  }

  function extractHandleFromPath(pathname) {
    const match = String(pathname || "").match(/\/products\/([^/?#]+)/i);
    return match ? decodeURIComponent(match[1]).trim().toLowerCase() : "";
  }

  function extractCollectionHandleFromPath(pathname) {
    const match = String(pathname || "").match(/\/collections\/([^/?#]+)/i);
    return match ? decodeURIComponent(match[1]).trim().toLowerCase() : "";
  }

  function getCustomerId(config) {
    return String((config && config.dataset && config.dataset.customerId) || "").trim();
  }

  function getProtectedCollectionHandle() {
    const handle = extractCollectionHandleFromPath(window.location.pathname);
    if (!handle) return "";
    return PROTECTED_COLLECTION_HANDLES.has(handle) ? handle : "";
  }

  function getProtectedProductHandle() {
    const handle = extractHandleFromPath(window.location.pathname);
    if (!handle) return "";
    return PROTECTED_PRODUCT_HANDLES.has(handle) ? handle : "";
  }

  function getHandleFromAnchor(anchor) {
    if (!(anchor instanceof HTMLAnchorElement)) return "";
    const href = anchor.getAttribute("href") || "";
    const productHandle = extractHandleFromPath(href);
    if (productHandle) return productHandle;

    const collectionHandle = extractCollectionHandleFromPath(href);
    if (collectionHandle) return collectionHandle;

    return "";
  }

  function getProtectedRoots() {
    const roots = [];
    const seen = new Set();
    const links = document.querySelectorAll("a[href*='/products/'], a[href*='/collections/']");

    for (const link of links) {
      if (!(link instanceof HTMLAnchorElement)) continue;
      const handle = getHandleFromAnchor(link);
      if (!handle) continue;

      const isProtected =
        PROTECTED_PRODUCT_HANDLES.has(handle) || PROTECTED_COLLECTION_HANDLES.has(handle);
      if (!isProtected) continue;

      const root = link.closest(CARD_ROOT_SELECTOR) || link.parentElement || link;
      if (!(root instanceof HTMLElement)) continue;

      if (!root.dataset.studentPricingProtectedKey) {
        root.dataset.studentPricingProtectedKey = `${handle}-${seen.size + 1}`;
      }
      const key = `${handle}::${root.dataset.studentPricingProtectedKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      roots.push({ handle, root });
    }

    return roots;
  }

  function setRootHidden(root, hidden) {
    if (!(root instanceof HTMLElement)) return;

    if (hidden) {
      if (!root.dataset.studentPricingOriginalDisplay) {
        root.dataset.studentPricingOriginalDisplay = root.style.display || "";
      }
      root.style.display = "none";
      root.setAttribute("data-student-pricing-protected-hidden", "true");
      return;
    }

    if (root.getAttribute("data-student-pricing-protected-hidden") !== "true") return;

    const originalDisplay = root.dataset.studentPricingOriginalDisplay || "";
    root.style.display = originalDisplay;
    root.removeAttribute("data-student-pricing-protected-hidden");
    delete root.dataset.studentPricingOriginalDisplay;
  }

  function unhideProtectedRoots() {
    for (const entry of getProtectedRoots()) {
      setRootHidden(entry.root, false);
    }
  }

  function buildAccessCheckParams(handle) {
    const params = {
      collectionHandle: "",
      productHandle: "",
    };

    if (!handle) return params;
    if (PROTECTED_PRODUCT_HANDLES.has(handle)) {
      params.productHandle = handle;
      return params;
    }

    params.collectionHandle = handle;
    return params;
  }

  function redirectTo(url) {
    if (!url) return;
    if (window.location.href === url) return;
    window.location.replace(url);
  }

  function buildReturnUrl() {
    const url = new URL(window.location.href);
    return `${url.pathname}${url.search}${url.hash}`;
  }

  function hidePageContent(message) {
    const target = document.querySelector("main") || document.querySelector("#MainContent") || document.body;
    if (!(target instanceof HTMLElement)) return;

    target.style.visibility = "hidden";
    target.style.pointerEvents = "none";

    let overlay = document.querySelector(".student-pricing-bundle-guard");
    if (!(overlay instanceof HTMLElement)) {
      overlay = document.createElement("div");
      overlay.className = "student-pricing-bundle-guard";
      overlay.style.position = "fixed";
      overlay.style.inset = "0";
      overlay.style.zIndex = "99999";
      overlay.style.display = "flex";
      overlay.style.alignItems = "center";
      overlay.style.justifyContent = "center";
      overlay.style.padding = "24px";
      overlay.style.background = "rgba(255,255,255,0.98)";
      overlay.style.color = "#111";
      overlay.style.textAlign = "center";
      overlay.style.fontFamily = "inherit";
      document.body.appendChild(overlay);
    }

    overlay.innerHTML =
      `<div style="max-width: 560px; margin: 0 auto;">` +
      `<h1 style="margin: 0 0 12px; font-size: 1.6rem; line-height: 1.25;">${escapeHtml(message)}</h1>` +
      `</div>`;
  }

  function isIgnoredPriceElement(candidate) {
    return candidate.closest(".student-pricing-preview") || candidate.classList.contains("student-pricing-preview");
  }

  async function fetchCollectionAccess(config, collectionHandle, productHandle) {
    const endpoint =
      config.dataset.bundleAccessEndpoint || "/apps/student-automatic-discount/proxy/bundle-access";
    const url = new URL(endpoint, window.location.origin);
    url.searchParams.set("shop", getShopDomain(config));
    const customerId = getCustomerId(config);
    if (customerId) {
      url.searchParams.set("logged_in_customer_id", customerId);
    }
    url.searchParams.set("collection_handle", collectionHandle);
    url.searchParams.set("product_handle", productHandle);

    const response = await fetch(url.toString(), {
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      const summary = bodyText.length > 240 ? `${bodyText.slice(0, 240)}...` : bodyText;
      throw new Error(`Bundle access request failed with ${response.status}: ${summary}`);
    }

    return response.json();
  }

  function findVisiblePriceElements(root) {
    const candidates = root.querySelectorAll(PRICE_SELECTOR);
    const matches = [];
    const seen = new Set();

    for (const candidate of candidates) {
      if (!(candidate instanceof HTMLElement)) continue;
      if (isIgnoredPriceElement(candidate)) continue;
      const text = candidate.textContent || "";
      if (!/\d/.test(text)) continue;
      const style = window.getComputedStyle(candidate);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      matches.push(candidate);
    }
    return matches;
  }

  function parseMoney(text) {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    const match = value.match(/(\d[\d.,\s]*)/);
    if (!match) return null;

    const rawNumber = match[1].replace(/\s+/g, "");
    const lastComma = rawNumber.lastIndexOf(",");
    const lastDot = rawNumber.lastIndexOf(".");
    const decimalIndex = Math.max(lastComma, lastDot);
    let normalized = rawNumber;

    if (decimalIndex >= 0) {
      const integerPart = rawNumber.slice(0, decimalIndex).replace(/[.,]/g, "");
      const decimalPart = rawNumber.slice(decimalIndex + 1).replace(/[.,]/g, "");
      normalized = `${integerPart}.${decimalPart}`;
    } else {
      normalized = rawNumber.replace(/[.,]/g, "");
    }

    const amount = Number(normalized);
    if (!Number.isFinite(amount)) return null;

    return {
      amount,
      prefix: value.slice(0, match.index),
      suffix: value.slice((match.index || 0) + match[1].length),
      decimals: decimalIndex >= 0 ? rawNumber.length - decimalIndex - 1 : 0
    };
  }

  function formatMoney(parsedMoney, discountedAmount) {
    return `${parsedMoney.prefix}${discountedAmount.toFixed(Math.min(Math.max(parsedMoney.decimals, 0), 2))}${parsedMoney.suffix}`.trim();
  }

  function getOriginalPriceText(priceElement) {
    const stored = String(priceElement.dataset.studentPricingOriginalText || "").trim();
    if (stored) return stored;

    const current = String(priceElement.textContent || "").trim();
    if (current) {
      priceElement.dataset.studentPricingOriginalText = current;
    }

    return current;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function buildPreview(priceElement, discountedText, labelText) {
    const existing = priceElement.parentElement && priceElement.parentElement.querySelector(".student-pricing-preview");
    if (existing) existing.remove();

    const preview = document.createElement("div");
    preview.className = "student-pricing-preview";
    if (priceElement.tagName === "SPAN") {
      preview.classList.add("is-inline");
    }
    const label = String(labelText || "Discounted price").trim() || "Discounted price";
    preview.innerHTML =
      `<span class="student-pricing-preview__label">${escapeHtml(label)}</span>` +
      `<span class="student-pricing-preview__price">${escapeHtml(discountedText)}</span>`;

    priceElement.classList.add("student-pricing-original");
    priceElement.insertAdjacentElement("afterend", preview);
  }

  function removePreview(priceElement) {
    const next = priceElement.nextElementSibling;
    if (next && next.classList && next.classList.contains("student-pricing-preview")) {
      next.remove();
    }
    priceElement.classList.remove("student-pricing-original");
  }

  function isLimitedOfferOriginalPrice(parsedMoney) {
    return parsedMoney && Math.abs(Number(parsedMoney.amount) - 2799) < 0.01;
  }

  async function clearCartDiscounts() {
    const root =
      (window.Shopify && window.Shopify.routes && window.Shopify.routes.root) ||
      "/";

    const response = await fetch(`${root}cart/update.js`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({ discount: "" })
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      const summary = bodyText.length > 200 ? `${bodyText.slice(0, 200)}...` : bodyText;
      throw new Error(`Failed to clear cart discount (${response.status}): ${summary}`);
    }
  }

  function collectTargets() {
    const targets = [];
    const seen = new Set();
    const productPageHandle = extractHandleFromPath(window.location.pathname);

    if (productPageHandle) {
      const productRoot =
        document.querySelector('main') ||
        document.querySelector('#MainContent') ||
        document.body;
      if (productRoot instanceof HTMLElement) {
        const priceElements = findVisiblePriceElements(productRoot);
        if (priceElements.length) {
          const key = `${productPageHandle}::product-page`;
          seen.add(key);
          targets.push({ handle: productPageHandle, priceElements, key });
        }
      }
    }

    const links = document.querySelectorAll('a[href*="/products/"]');
    for (const link of links) {
      if (!(link instanceof HTMLAnchorElement)) continue;
      const handle = extractHandleFromPath(link.getAttribute("href"));
      if (!handle) continue;

      const root = link.closest(CARD_ROOT_SELECTOR) || link.parentElement;
      if (!(root instanceof HTMLElement)) continue;

      const priceElements = findVisiblePriceElements(root);
      if (!priceElements.length) continue;

      if (!root.dataset.studentPricingKey) {
        root.dataset.studentPricingKey = `${handle}-${seen.size + 1}`;
      }
      const key = `${handle}::${root.dataset.studentPricingKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ handle, priceElements, key });
    }

    const cartLines = document.querySelectorAll(CART_LINE_SELECTOR);
    for (const root of cartLines) {
      if (!(root instanceof HTMLElement)) continue;

      const text = String(root.textContent || "").toLowerCase();
      if (!text.includes(LIMITED_OFFER_TITLE) || !text.includes(LIMITED_OFFER_STORAGE)) continue;

      const priceElements = findVisiblePriceElements(root);
      if (!priceElements.length) continue;

      if (!root.dataset.studentPricingKey) {
        root.dataset.studentPricingKey = `${LIMITED_OFFER_HANDLE}-cart-${seen.size + 1}`;
      }
      const key = `${LIMITED_OFFER_HANDLE}::${root.dataset.studentPricingKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ handle: LIMITED_OFFER_HANDLE, priceElements, key });
    }

    return targets;
  }

  async function fetchPricing(config, handles) {
    const endpoint = config.dataset.endpoint || "/apps/student-automatic-discount/proxy/student-pricing";
    const url = new URL(endpoint, window.location.origin);
    url.searchParams.set("shop", getShopDomain(config));
    url.searchParams.set("logged_in_customer_id", config.dataset.customerId || "");
    url.searchParams.set("handles", handles.join(","));

    const response = await fetch(url.toString(), {
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      const summary = bodyText.length > 240 ? `${bodyText.slice(0, 240)}...` : bodyText;
      throw new Error(`Student pricing request failed with ${response.status}: ${summary}`);
    }

    return response.json();
  }

  async function fetchCleanupStatus(config) {
    const endpoint = config.dataset.endpoint || "/apps/student-automatic-discount/proxy/student-pricing";
    const url = new URL(endpoint, window.location.origin);
    url.searchParams.set("shop", getShopDomain(config));
    url.searchParams.set("logged_in_customer_id", config.dataset.customerId || "");
    url.searchParams.set("cleanup", "1");

    const response = await fetch(url.toString(), {
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      const summary = bodyText.length > 240 ? `${bodyText.slice(0, 240)}...` : bodyText;
      throw new Error(`Student pricing cleanup request failed with ${response.status}: ${summary}`);
    }

    return response.json();
  }

  async function applyStudentPricing() {
    const currentToken = ++requestToken;
    const config = getConfig();
    if (!(config instanceof HTMLElement)) return;

    const targets = collectTargets();
    const protectedCollectionHandle = getProtectedCollectionHandle();
    const protectedProductHandle = getProtectedProductHandle();
    const protectedHandle = protectedCollectionHandle || protectedProductHandle;
    const protectedRoots = getProtectedRoots();
    const protectedRootHandle = protectedHandle || protectedRoots[0]?.handle || "";
    const needsAccessCheck = Boolean(protectedRootHandle);

    if (needsAccessCheck) {
      try {
        const { collectionHandle, productHandle } = buildAccessCheckParams(protectedRootHandle);
        const access = await fetchCollectionAccess(config, collectionHandle, productHandle);
        if (currentToken !== requestToken) return;

        if (!access || !access.ok || !access.allowed) {
          for (const entry of protectedRoots) {
            setRootHidden(entry.root, true);
          }

          if (protectedHandle) {
            hidePageContent(
              access?.reason === "no_customer"
                ? "Please sign in with your BISR account to view this page."
                : "This page is only available to BISR customers.",
            );

            const returnUrl = encodeURIComponent(buildReturnUrl());
            const customerId = getCustomerId(config);
            if (!customerId && window.location.pathname !== "/account/login") {
              redirectTo(`/account/login?return_url=${returnUrl}`);
            } else {
              redirectTo("/");
            }
          }

          return;
        }

        unhideProtectedRoots();

        if (protectedHandle) {
          document.documentElement.classList.remove("student-pricing-pending");
          const overlay = document.querySelector(".student-pricing-bundle-guard");
          if (overlay instanceof HTMLElement) overlay.remove();
          const target = document.querySelector("main") || document.querySelector("#MainContent") || document.body;
          if (target instanceof HTMLElement) {
            target.style.visibility = "";
            target.style.pointerEvents = "";
          }
        }
      } catch (error) {
        console.warn("[student-pricing] failed to verify bundle collection access", error);
      }
    }

    let cleanupPayload = null;
    try {
      cleanupPayload = await fetchCleanupStatus(config);
    } catch (error) {
      console.warn("[student-pricing] failed to fetch cleanup status", error);
    }

    if (currentToken !== requestToken) return;

    if (cleanupPayload && cleanupPayload.ok && cleanupPayload.shouldClearCartDiscount) {
      try {
        await clearCartDiscounts();
      } catch (error) {
        console.warn("[student-pricing] failed to clear cart discounts", error);
      }
    }

    if (!targets.length) return;

    const handles = Array.from(new Set(targets.map((target) => target.handle)));
    let payload;
    try {
      payload = await fetchPricing(config, handles);
    } catch (error) {
      console.warn("[student-pricing] failed to fetch pricing", error);
      return;
    }

    if (currentToken !== requestToken) return;
    if (!payload || !payload.ok || !payload.byHandle) return;

    if (payload.reason === "no_rules") {
      try {
        await clearCartDiscounts();
      } catch (error) {
        console.warn("[student-pricing] failed to clear cart discounts", error);
      }
    }

    if (observer) {
      observer.disconnect();
    }

    try {
      for (const target of targets) {
        const pricing = payload.byHandle[target.handle];
        const percentage = Number(pricing && pricing.percentage);
        const fixedDiscountedAmount = Number(pricing && pricing.discountedAmount);
        const hasFixedDiscountedAmount = Number.isFinite(fixedDiscountedAmount) && fixedDiscountedAmount > 0;
        if (!hasFixedDiscountedAmount && (!Number.isFinite(percentage) || percentage <= 0)) {
          for (const priceElement of target.priceElements) {
            removePreview(priceElement);
          }
          continue;
        }

        for (const priceElement of target.priceElements) {
          const parsedMoney = parseMoney(getOriginalPriceText(priceElement));
          if (!parsedMoney || parsedMoney.amount <= 0) continue;
          if (target.handle === LIMITED_OFFER_HANDLE && !isLimitedOfferOriginalPrice(parsedMoney)) continue;

          const discountedAmount = hasFixedDiscountedAmount
            ? fixedDiscountedAmount
            : parsedMoney.amount * (1 - percentage / 100);
          buildPreview(
            priceElement,
            formatMoney(parsedMoney, discountedAmount),
            pricing && pricing.label
          );
        }
      }
    } finally {
      if (observer) {
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true
        });
      }
    }
  }

  function scheduleApply() {
    window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(() => {
      applyStudentPricing().catch((error) => {
        console.warn("[student-pricing] apply failed", error);
      });
    }, 180);
  }

  document.addEventListener("DOMContentLoaded", scheduleApply);
  window.addEventListener("pageshow", scheduleApply);
  document.addEventListener("shopify:section:load", scheduleApply);
  document.addEventListener("shopify:section:reorder", scheduleApply);
  document.addEventListener("shopify:section:select", scheduleApply);

  observer = new MutationObserver(scheduleApply);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  scheduleApply();
})();
