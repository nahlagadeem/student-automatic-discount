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

  function isIgnoredPriceElement(candidate) {
    return candidate.closest(".student-pricing-preview") || candidate.classList.contains("student-pricing-preview");
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
    if (!config.dataset.customerId) return;

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

    const targets = collectTargets();
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
        if (!hasFixedDiscountedAmount && (!Number.isFinite(percentage) || percentage <= 0)) continue;

        for (const priceElement of target.priceElements) {
          const parsedMoney = parseMoney(getOriginalPriceText(priceElement));
          if (!parsedMoney || parsedMoney.amount <= 0) continue;

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
