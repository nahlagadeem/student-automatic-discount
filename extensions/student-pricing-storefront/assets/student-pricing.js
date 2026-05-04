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

  function getConfig() {
    return document.querySelector(CONFIG_SELECTOR);
  }

  function extractHandleFromPath(pathname) {
    const match = String(pathname || "").match(/\/products\/([^/?#]+)/i);
    return match ? decodeURIComponent(match[1]).trim().toLowerCase() : "";
  }

  function findVisiblePriceElement(root) {
    const candidates = root.querySelectorAll(PRICE_SELECTOR);
    for (const candidate of candidates) {
      if (!(candidate instanceof HTMLElement)) continue;
      if (candidate.closest(".student-pricing-preview")) continue;
      const text = candidate.textContent || "";
      if (!/\d/.test(text)) continue;
      const style = window.getComputedStyle(candidate);
      if (style.display === "none" || style.visibility === "hidden") continue;
      return candidate;
    }
    return null;
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

  function buildPreview(priceElement, discountedText, percentage) {
    const existing = priceElement.parentElement && priceElement.parentElement.querySelector(".student-pricing-preview");
    if (existing) existing.remove();

    const preview = document.createElement("div");
    preview.className = "student-pricing-preview";
    if (priceElement.tagName === "SPAN") {
      preview.classList.add("is-inline");
    }
    preview.innerHTML =
      `<span class="student-pricing-preview__label">Student price</span>` +
      `<span class="student-pricing-preview__price">${discountedText}</span>` +
      `<span class="student-pricing-preview__label">${percentage}% off</span>`;

    priceElement.classList.add("student-pricing-original");
    priceElement.insertAdjacentElement("afterend", preview);
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
        const priceElement = findVisiblePriceElement(productRoot);
        if (priceElement) {
          const key = `${productPageHandle}::product-page`;
          seen.add(key);
          targets.push({ handle: productPageHandle, priceElement, key });
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

      const priceElement = findVisiblePriceElement(root);
      if (!priceElement) continue;

      if (!root.dataset.studentPricingKey) {
        root.dataset.studentPricingKey = `${handle}-${seen.size + 1}`;
      }
      const key = `${handle}::${root.dataset.studentPricingKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ handle, priceElement, key });
    }

    return targets;
  }

  async function fetchPricing(config, handles) {
    const url = new URL(config.dataset.endpoint, window.location.origin);
    url.searchParams.set("shop", config.dataset.shop || window.location.hostname);
    url.searchParams.set("logged_in_customer_id", config.dataset.customerId || "");
    url.searchParams.set("handles", handles.join(","));

    const response = await fetch(url.toString(), {
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    });

    if (!response.ok) {
      throw new Error(`Student pricing request failed with ${response.status}`);
    }

    return response.json();
  }

  async function applyStudentPricing() {
    const config = getConfig();
    if (!(config instanceof HTMLElement)) return;
    if (!config.dataset.customerId) return;

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

    if (!payload || !payload.ok || !payload.byHandle) return;

    if (observer) {
      observer.disconnect();
    }

    try {
      for (const target of targets) {
        const pricing = payload.byHandle[target.handle];
        const percentage = Number(pricing && pricing.percentage);
        if (!Number.isFinite(percentage) || percentage <= 0) continue;

        const parsedMoney = parseMoney(target.priceElement.textContent || "");
        if (!parsedMoney || parsedMoney.amount <= 0) continue;

        const discountedAmount = parsedMoney.amount * (1 - percentage / 100);
        buildPreview(target.priceElement, formatMoney(parsedMoney, discountedAmount), percentage);
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
