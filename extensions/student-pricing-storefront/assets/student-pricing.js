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
    "[class*='grid__item']",
    ".product-item",
    ".product-card",
    "product-card",
    ".collection-list__item",
    ".collection-card",
    "[class*='collection-card']",
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
  const APPLECARE_TEXT_PATTERN = /apple\s*care\+?/i;
  const APPLECARE_PRICE_SELECTOR = [
    PRICE_SELECTOR,
    "span",
    "p",
    "strong",
    "b",
    "div"
  ].join(",");
  const APPLECARE_ROOT_SELECTOR = [
    "[class*='applecare']",
    "[class*='apple-care']",
    "[id*='applecare']",
    "[id*='apple-care']",
    "[data-applecare]",
    "[data-apple-care]",
    "section",
    "article",
    "form",
    "div",
    "li"
  ].join(",");
  const FALLBACK_PROTECTED_COLLECTION_HANDLES = ["bundle", "all-bundles"];
  const FALLBACK_PROTECTED_PRODUCT_HANDLES = ["primary-years-bundle"];
  let PROTECTED_COLLECTION_HANDLES = new Set(FALLBACK_PROTECTED_COLLECTION_HANDLES);
  let PROTECTED_PRODUCT_HANDLES = new Set(FALLBACK_PROTECTED_PRODUCT_HANDLES);

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

  function normalizeVariantId(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (raw.startsWith("gid://shopify/ProductVariant/")) return raw;
    const numericMatch = raw.match(/\d{8,}/);
    return numericMatch ? `gid://shopify/ProductVariant/${numericMatch[0]}` : "";
  }

  function getVariantIdFromRoot(root) {
    if (!(root instanceof HTMLElement)) return "";

    const datasetVariant =
      root.dataset.variantId ||
      root.dataset.productVariantId ||
      root.dataset.studentPricingVariantId ||
      "";
    const normalizedDatasetVariant = normalizeVariantId(datasetVariant);
    if (normalizedDatasetVariant) return normalizedDatasetVariant;

    const variantCarrier = root.querySelector(
      "[data-variant-id], [data-product-variant-id], [data-student-pricing-variant-id], [data-id], [data-variant], [data-variantid]"
    );
    if (variantCarrier instanceof HTMLElement) {
      const normalizedCarrierVariant = normalizeVariantId(
        variantCarrier.dataset.variantId ||
          variantCarrier.dataset.productVariantId ||
          variantCarrier.dataset.studentPricingVariantId ||
          variantCarrier.dataset.id ||
          variantCarrier.dataset.variant ||
          variantCarrier.dataset.variantid ||
          ""
      );
      if (normalizedCarrierVariant) return normalizedCarrierVariant;
    }

    const variantInput = root.querySelector(
      'input[name="id"], select[name="id"], input[name="variant"], select[name="variant"], button[name="id"], button[value]'
    );
    if (
      variantInput instanceof HTMLInputElement ||
      variantInput instanceof HTMLSelectElement ||
      variantInput instanceof HTMLButtonElement
    ) {
      return normalizeVariantId(variantInput.value);
    }

    return "";
  }

  function findAppleCareContainer(element) {
    let current = element instanceof HTMLElement ? element : null;
    let steps = 0;

    while (current && current !== document.body && steps < 8) {
      if (APPLECARE_TEXT_PATTERN.test(String(current.textContent || ""))) {
        return current;
      }
      current = current.parentElement;
      steps += 1;
    }

    return null;
  }

  function getHandleFromRoot(root) {
    if (!(root instanceof HTMLElement)) return "";

    const datasetHandle =
      root.dataset.productHandle ||
      root.dataset.handle ||
      root.dataset.studentPricingProductHandle ||
      "";
    if (datasetHandle) return String(datasetHandle).trim().toLowerCase();

    const handleCarrier = root.querySelector(
      "[data-product-handle], [data-handle], [data-student-pricing-product-handle]"
    );
    if (handleCarrier instanceof HTMLElement) {
      const carrierHandle =
        handleCarrier.dataset.productHandle ||
        handleCarrier.dataset.handle ||
        handleCarrier.dataset.studentPricingProductHandle ||
        "";
      if (carrierHandle) return String(carrierHandle).trim().toLowerCase();
    }

    const productLink = root.querySelector('a[href*="/products/"]');
    if (productLink instanceof HTMLAnchorElement) {
      return extractHandleFromPath(productLink.getAttribute("href"));
    }

    return "";
  }

  function getCustomerId(config) {
    return String((config && config.dataset && config.dataset.customerId) || "").trim();
  }

  function parseHandleList(value, fallbackHandles) {
    const handles = String(value || "")
      .split(",")
      .map((handle) => handle.trim().toLowerCase())
      .filter(Boolean);

    return new Set(handles.length ? handles : fallbackHandles);
  }

  function configureProtectedHandles(config) {
    if (!(config instanceof HTMLElement)) return;

    PROTECTED_COLLECTION_HANDLES = parseHandleList(
      config.dataset.protectedCollectionHandles,
      FALLBACK_PROTECTED_COLLECTION_HANDLES
    );
    PROTECTED_PRODUCT_HANDLES = parseHandleList(
      config.dataset.protectedProductHandles,
      FALLBACK_PROTECTED_PRODUCT_HANDLES
    );
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
    const currentCollectionHandle = extractCollectionHandleFromPath(window.location.pathname);
    const isBundleCollectionPage = PROTECTED_COLLECTION_HANDLES.has(currentCollectionHandle);

    for (const link of links) {
      if (!(link instanceof HTMLAnchorElement)) continue;
      const handle = getHandleFromAnchor(link);
      if (!handle) continue;

      const isProtected =
        PROTECTED_PRODUCT_HANDLES.has(handle) ||
        PROTECTED_COLLECTION_HANDLES.has(handle) ||
        (isBundleCollectionPage && !PROTECTED_COLLECTION_HANDLES.has(handle));
      if (!isProtected) continue;

      const isNavigationLink = Boolean(link.closest("header, nav, [role='navigation']"));
      const root = isNavigationLink
        ? link
        : link.closest(CARD_ROOT_SELECTOR) || link.parentElement || link;
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

  function hideProtectedRoots(roots) {
    for (const entry of roots) {
      setRootHidden(entry.root, true);
    }
  }

  function setBundleAccessAllowed(allowed) {
    document.documentElement.classList.toggle("student-pricing-bundle-access-allowed", Boolean(allowed));
  }

  function buildAccessCheckParams(handle) {
    const params = {
      collectionHandle: "",
      productHandle: "",
    };

    if (!handle) return params;
    if (!PROTECTED_COLLECTION_HANDLES.has(handle)) {
      params.productHandle = handle;
      return params;
    }

    params.collectionHandle = handle;
    return params;
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

  function findAppleCarePriceElements(root) {
    const candidates = root.querySelectorAll(APPLECARE_PRICE_SELECTOR);
    const matches = [];
    const seen = new Set();

    for (const candidate of candidates) {
      if (!(candidate instanceof HTMLElement)) continue;
      if (candidate === root) continue;
      if (isIgnoredPriceElement(candidate)) continue;

      const text = String(candidate.textContent || "").replace(/\s+/g, " ").trim();
      if (!/\d/.test(text)) continue;
      if (!/(sar|ر\.?س|ريال|price)/i.test(text)) continue;

      const parsed = parseMoney(text);
      if (!parsed || parsed.amount <= 0) continue;

      const childWithMoney = Array.from(candidate.children).some((child) => {
        if (!(child instanceof HTMLElement)) return false;
        const childText = String(child.textContent || "").replace(/\s+/g, " ").trim();
        return /\d/.test(childText) && /(sar|ر\.?س|ريال|price)/i.test(childText);
      });
      if (childWithMoney) continue;

      const style = window.getComputedStyle(candidate);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      matches.push(candidate);
    }

    return matches.length ? matches : findVisiblePriceElements(root);
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

  function setPriceElementAmount(priceElement, amount) {
    const parsedMoney = parseMoney(getOriginalPriceText(priceElement)) || {
      prefix: "",
      suffix: "",
      decimals: 2
    };
    const updatedText = formatMoney(parsedMoney, amount);
    priceElement.textContent = updatedText;
    priceElement.dataset.studentPricingOriginalText = updatedText;
    return parseMoney(updatedText);
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

    const explicitAppleCareRoots = document.querySelectorAll(
      "[data-student-pricing-product-handle], [data-product-handle], [data-student-pricing-variant-id], [data-variant-id], [data-product-variant-id], [data-id], [data-variant], [data-variantid], button[value], input[value]"
    );
    for (const marker of explicitAppleCareRoots) {
      if (!(marker instanceof HTMLElement)) continue;
      const root = findAppleCareContainer(marker);
      if (!(root instanceof HTMLElement)) continue;

      const handle = getHandleFromRoot(root);
      const variantId = getVariantIdFromRoot(root);
      if (!handle && !variantId) continue;

      const priceElements = findAppleCarePriceElements(root);
      if (!priceElements.length) continue;

      const targetId = handle || variantId;
      if (!root.dataset.studentPricingKey) {
        root.dataset.studentPricingKey = `${targetId}-applecare-${seen.size + 1}`;
      }
      const key = `${targetId}::${root.dataset.studentPricingKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ handle, variantId, priceElements, key });
    }

    const appleCareRoots = document.querySelectorAll(APPLECARE_ROOT_SELECTOR);
    for (const root of appleCareRoots) {
      if (!(root instanceof HTMLElement)) continue;
      const text = String(root.textContent || "");
      if (!APPLECARE_TEXT_PATTERN.test(text)) continue;

      const handle = getHandleFromRoot(root);
      const variantId = getVariantIdFromRoot(root);
      if (!handle && !variantId) continue;

      const priceElements = findAppleCarePriceElements(root);
      if (!priceElements.length) continue;

      const targetId = handle || variantId;
      if (!root.dataset.studentPricingKey) {
        root.dataset.studentPricingKey = `${targetId}-applecare-${seen.size + 1}`;
      }
      const key = `${targetId}::${root.dataset.studentPricingKey}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({
        handle,
        variantId,
        priceElements,
        key
      });
    }

    return targets;
  }

  async function fetchPricing(config, handles, variantIds) {
    const endpoint = config.dataset.endpoint || "/apps/student-automatic-discount/proxy/student-pricing";
    const url = new URL(endpoint, window.location.origin);
    url.searchParams.set("shop", getShopDomain(config));
    url.searchParams.set("logged_in_customer_id", config.dataset.customerId || "");
    url.searchParams.set("handles", handles.join(","));
    if (variantIds.length) {
      url.searchParams.set("variant_ids", variantIds.join(","));
    }

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
    configureProtectedHandles(config);

    const targets = collectTargets();
    const protectedCollectionHandle = getProtectedCollectionHandle();
    const protectedProductHandle = getProtectedProductHandle();
    const protectedHandle = protectedCollectionHandle || protectedProductHandle;
    const protectedRoots = getProtectedRoots();
    const protectedRootEntries = protectedRoots.filter((entry) => entry.handle !== protectedHandle);
    const needsAccessCheck = Boolean(protectedHandle || protectedRootEntries.length);

    if (needsAccessCheck) {
      try {
        if (protectedHandle) {
          const { collectionHandle, productHandle } = buildAccessCheckParams(protectedHandle);
          const accessPayload = await fetchCollectionAccess(config, collectionHandle, productHandle);

          if (!accessPayload || accessPayload.allowed !== true) {
            setBundleAccessAllowed(false);
            hideProtectedRoots(protectedRoots);

            if (protectedProductHandle) {
              window.location.replace("/");
            }

            if (protectedProductHandle) return;
          } else {
            setBundleAccessAllowed(true);

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
          }
        }

        for (const entry of protectedRootEntries) {
          const { collectionHandle, productHandle } = buildAccessCheckParams(entry.handle);
          const accessPayload = await fetchCollectionAccess(config, collectionHandle, productHandle);
          if (!accessPayload || accessPayload.allowed !== true) {
            setRootHidden(entry.root, true);
          } else {
            setRootHidden(entry.root, false);
          }
        }
      } catch (error) {
        console.warn("[student-pricing] failed to verify bundle collection access", error);
        setBundleAccessAllowed(false);
        hideProtectedRoots(protectedRoots);

        if (protectedHandle) {
          window.location.replace("/");
          return;
        }
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

    const pricedTargets = targets;
    if (!pricedTargets.length) return;

    const handles = Array.from(new Set(pricedTargets.map((target) => target.handle).filter(Boolean)));
    const variantIds = Array.from(new Set(pricedTargets.map((target) => target.variantId).filter(Boolean)));
    let payload;
    try {
      payload = await fetchPricing(config, handles, variantIds);
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
      for (const target of pricedTargets) {
        const pricing =
          (target.handle && payload.byHandle[target.handle]) ||
          (target.variantId && payload.byVariantId && payload.byVariantId[target.variantId]);
        const percentage = Number(pricing && pricing.percentage);
        const originalAmount = Number(pricing && pricing.originalAmount);
        const hasOriginalAmount = target.variantId && Number.isFinite(originalAmount) && originalAmount > 0;
        const fixedDiscountedAmount = Number(pricing && pricing.discountedAmount);
        const hasFixedDiscountedAmount = Number.isFinite(fixedDiscountedAmount) && fixedDiscountedAmount > 0;
        if (!hasOriginalAmount && !hasFixedDiscountedAmount && (!Number.isFinite(percentage) || percentage <= 0)) {
          for (const priceElement of target.priceElements) {
            removePreview(priceElement);
          }
          continue;
        }

        for (const priceElement of target.priceElements) {
          const parsedMoney = hasOriginalAmount
            ? setPriceElementAmount(priceElement, originalAmount)
            : parseMoney(getOriginalPriceText(priceElement));
          if (!parsedMoney || parsedMoney.amount <= 0) continue;
          if (target.handle === LIMITED_OFFER_HANDLE && !isLimitedOfferOriginalPrice(parsedMoney)) continue;

          if (!hasFixedDiscountedAmount && (!Number.isFinite(percentage) || percentage <= 0)) {
            removePreview(priceElement);
            continue;
          }

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
