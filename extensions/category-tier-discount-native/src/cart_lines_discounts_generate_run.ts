import {
  DiscountClass,
  ProductDiscountSelectionStrategy,
  CartInput,
  CartLinesDiscountsGenerateRunResult,
  ProductDiscountCandidate,
} from '../generated/api';

type TierConfig = {
  ipadPercentage: number;
  macPercentage: number;
  accessoriesPercentage: number;
  iphonePercentage: number;
  appleWatchPercentage: number;
  tvHomePercentage: number;
  airpodsPercentage: number;
};

type RuleConfig = Partial<TierConfig> & {
  version?: number;
  mode?: string;
  codePercentage?: number;
  automaticConfig?: RuleConfig | null;
  codeConfig?: RuleConfig | null;
  eligibleInstituteKeys?: string[];
  limitedTimeOffers?: LimitedTimeOfferConfig[];
  rules?: {
    instituteKey?: string;
    instituteLabel?: string;
    emailDomain?: string;
    categoryKey?: string;
    categoryLabel?: string;
    collectionId?: string;
    percentage?: number;
  }[];
  collectionIds?: string[];
};

type LimitedTimeOfferConfig = {
  key?: string;
  variantIds?: string[];
  discountAmount?: number;
  label?: string;
  startDateTime?: string;
  endDateTime?: string;
  eligibleInstituteKeys?: string[];
};

type MatchedRule = {
  categoryKey: string;
  collectionId: string;
  percentage: number;
};

type ProductLineProduct = Extract<
  CartInput["cart"]["lines"][number]["merchandise"],
  { __typename: "ProductVariant" }
>["product"];

const DEFAULT_CONFIG: TierConfig = {
  ipadPercentage: 0,
  macPercentage: 0,
  accessoriesPercentage: 0,
  iphonePercentage: 0,
  appleWatchPercentage: 0,
  tvHomePercentage: 0,
  airpodsPercentage: 0,
};

const CATEGORY_COLLECTION_IDS: Record<string, string> = {
  ipad: "gid://shopify/Collection/452991221978",
  mac: "gid://shopify/Collection/452991746266",
  accessories: "gid://shopify/Collection/453527797978",
  iphone: "gid://shopify/Collection/452991123674",
  "apple-watch": "gid://shopify/Collection/52991287514",
  "tv-home": "gid://shopify/Collection/453560008922",
  airpods: "gid://shopify/Collection/453560271066",
};

function clampPercentage(value: unknown, fallback: number): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  if (numberValue < 0) return 0;
  if (numberValue > 100) return 100;
  return numberValue;
}

function getBuyerInstituteKeyFromTags(input: CartInput): string {
  return String(input.cart.buyerIdentity?.customer?.metafield?.value || "").trim();
}

function readTierConfigFromConfig(config: Partial<TierConfig> | null | undefined): TierConfig {
  return {
    ipadPercentage: clampPercentage(config?.ipadPercentage, DEFAULT_CONFIG.ipadPercentage),
    macPercentage: clampPercentage(config?.macPercentage, DEFAULT_CONFIG.macPercentage),
    accessoriesPercentage: clampPercentage(config?.accessoriesPercentage, DEFAULT_CONFIG.accessoriesPercentage),
    iphonePercentage: clampPercentage(config?.iphonePercentage, DEFAULT_CONFIG.iphonePercentage),
    appleWatchPercentage: clampPercentage(config?.appleWatchPercentage, DEFAULT_CONFIG.appleWatchPercentage),
    tvHomePercentage: clampPercentage(config?.tvHomePercentage, DEFAULT_CONFIG.tvHomePercentage),
    airpodsPercentage: clampPercentage(config?.airpodsPercentage, DEFAULT_CONFIG.airpodsPercentage),
  };
}

function readRawConfig(input: CartInput): RuleConfig {
  const rawValue = input.discount.metafield?.value;
  if (!rawValue) return {};

  try {
    return JSON.parse(rawValue) as RuleConfig;
  } catch {
    return {};
  }
}

function readRuleConfigFromConfig(input: CartInput, config: RuleConfig | null | undefined): MatchedRule[] {
  if (!Array.isArray(config?.rules)) return [];

  const buyerInstituteKey = getBuyerInstituteKeyFromTags(input);
  if (!buyerInstituteKey) return [];

  return config.rules
    .filter((rule) => String(rule.instituteKey || "").trim() === buyerInstituteKey)
    .map((rule) => ({
      categoryKey: String(rule.categoryKey || "").trim(),
      collectionId: String(rule.collectionId || "").trim(),
      percentage: clampPercentage(rule.percentage, 0),
    }))
    .filter((rule) => (rule.categoryKey || rule.collectionId) && rule.percentage > 0);
}

function readMacbookNeoOffer(config: RuleConfig | null | undefined): LimitedTimeOfferConfig | null {
  if (!Array.isArray(config?.limitedTimeOffers)) return null;

  const offer = config.limitedTimeOffers.find(
    (item) => String(item?.key || "").trim() === "macbook-neo-256gb-limited-offer",
  );
  const discountAmount = Number(offer?.discountAmount);
  const variantIds = Array.isArray(offer?.variantIds)
    ? offer.variantIds.map((id) => String(id || "").trim()).filter(Boolean)
    : [];

  if (!offer || !variantIds.length || !Number.isFinite(discountAmount) || discountAmount <= 0) {
    return null;
  }

  return {
    ...offer,
    discountAmount,
    variantIds,
    label: String(offer.label || "Limited time offer").trim() || "Limited time offer",
  };
}

function buyerCanUseLimitedTimeOffer(input: CartInput, offer: LimitedTimeOfferConfig | null): boolean {
  if (!offer) return false;
  const eligibleInstituteKeys = Array.isArray(offer.eligibleInstituteKeys)
    ? offer.eligibleInstituteKeys.map((key) => String(key || "").trim()).filter(Boolean)
    : [];

  if (!eligibleInstituteKeys.length) return true;
  const buyerInstituteKey = getBuyerInstituteKeyFromTags(input);
  return Boolean(buyerInstituteKey && eligibleInstituteKeys.includes(buyerInstituteKey));
}

function isProductInCollection(product: ProductLineProduct, collectionId: string): boolean {
  if (!collectionId) return false;

  return product.collections.some(
    (membership) => membership.collectionId === collectionId && membership.isMember,
  );
}

function isProductInCategory(product: ProductLineProduct, categoryKey: string): boolean {
  if (categoryKey.startsWith("gid://shopify/Collection/")) {
    return isProductInCollection(product, categoryKey);
  }

  return isProductInCollection(product, CATEGORY_COLLECTION_IDS[categoryKey]);
}

function getLinePercentageFromRules(product: ProductLineProduct, rules: MatchedRule[]): number {
  if (!rules.length) return 0;

  let maxPercentage = 0;
  for (const rule of rules) {
    const isMatch =
      isProductInCollection(product, rule.collectionId) ||
      isProductInCategory(product, rule.categoryKey);

    if (isMatch) {
      maxPercentage = Math.max(maxPercentage, rule.percentage);
    }
  }

  return maxPercentage;
}

function getLinePercentageFromConfig(
  input: CartInput,
  product: ProductLineProduct,
  config: RuleConfig | null | undefined,
): number {
  const matchedRules = readRuleConfigFromConfig(input, config);
  if (matchedRules.length) {
    return getLinePercentageFromRules(product, matchedRules);
  }

  const tierConfig = readTierConfigFromConfig(config);
  return Math.max(
    isProductInCategory(product, "mac") ? tierConfig.macPercentage : 0,
    isProductInCategory(product, "ipad") ? tierConfig.ipadPercentage : 0,
    isProductInCategory(product, "accessories") ? tierConfig.accessoriesPercentage : 0,
    isProductInCategory(product, "iphone") ? tierConfig.iphonePercentage : 0,
    isProductInCategory(product, "apple-watch") ? tierConfig.appleWatchPercentage : 0,
    isProductInCategory(product, "tv-home") ? tierConfig.tvHomePercentage : 0,
    isProductInCategory(product, "airpods") ? tierConfig.airpodsPercentage : 0,
    0,
  );
}

function getMaxConfiguredPercentage(config: RuleConfig | null | undefined): number {
  const rules = Array.isArray(config?.rules) ? config.rules : [];
  const maxRulePercentage = rules.reduce(
    (maxPercentage, rule) => Math.max(maxPercentage, clampPercentage(rule.percentage, 0)),
    0,
  );
  const tierConfig = readTierConfigFromConfig(config);

  return Math.max(
    maxRulePercentage,
    tierConfig.macPercentage,
    tierConfig.ipadPercentage,
    tierConfig.accessoriesPercentage,
    tierConfig.iphonePercentage,
    tierConfig.appleWatchPercentage,
    tierConfig.tvHomePercentage,
    tierConfig.airpodsPercentage,
    0,
  );
}

export function cartLinesDiscountsGenerateRun(
  input: CartInput,
): CartLinesDiscountsGenerateRunResult {
  if (!input.cart.lines.length) {
    return {operations: []};
  }

  const hasProductDiscountClass = input.discount.discountClasses.includes(
    DiscountClass.Product,
  );

  if (!hasProductDiscountClass) {
    return {operations: []};
  }

  const rawConfig = readRawConfig(input);
  const isStudentCodeDiscount = rawConfig.mode === "student-code";
  const isCodeWithAutomaticExclusions = rawConfig.mode === "code-with-automatic-exclusions";
  const isCodeDiscountTrigger = isStudentCodeDiscount || isCodeWithAutomaticExclusions;
  const codePercentage = clampPercentage(rawConfig.codePercentage, 0);
  const codeConfig = isCodeWithAutomaticExclusions && rawConfig.codeConfig ? rawConfig.codeConfig : rawConfig;
  const automaticConfig =
    (isStudentCodeDiscount || isCodeWithAutomaticExclusions) && rawConfig.automaticConfig
      ? rawConfig.automaticConfig
      : null;
  const offerConfig = readMacbookNeoOffer(automaticConfig || rawConfig);
  const isOfferActive = buyerCanUseLimitedTimeOffer(input, offerConfig);
  const offerVariantIds = new Set(offerConfig?.variantIds ?? []);
  const productLinesByPercent: Record<number, {id: string; quantity: number}[]> =
    {};
  const codeFallbackLines: {id: string; quantity: number}[] = [];
  const candidates: ProductDiscountCandidate[] = [];
  let skippedOfferLineForCode = false;

  for (const line of input.cart.lines) {
    if (line.merchandise.__typename !== "ProductVariant") continue;

    const product = line.merchandise.product;
    if (isOfferActive && offerVariantIds.has(line.merchandise.id)) {
      if (isCodeDiscountTrigger) {
        skippedOfferLineForCode = true;
        continue;
      }

      candidates.push({
        message: offerConfig?.label || "Limited time offer",
        targets: [
          {
            cartLine: {
              id: line.id,
              quantity: line.quantity,
            },
          },
        ],
        value: {
          fixedAmount: {
            amount: String(offerConfig?.discountAmount ?? 409),
            appliesToEachItem: true,
          },
        },
      });
      continue;
    }

    const automaticPercentage = automaticConfig
      ? getLinePercentageFromConfig(input, product, automaticConfig)
      : 0;
    if (isCodeDiscountTrigger && automaticPercentage <= 0) {
      codeFallbackLines.push({id: line.id, quantity: line.quantity});
    }

    const codeLinePercentage = isStudentCodeDiscount
      ? codePercentage
      : getLinePercentageFromConfig(input, product, codeConfig);
    const appliedPercentage = automaticPercentage > 0 ? 0 : codeLinePercentage;

    if (appliedPercentage <= 0) continue;
    if (!productLinesByPercent[appliedPercentage]) {
      productLinesByPercent[appliedPercentage] = [];
    }
    productLinesByPercent[appliedPercentage].push({id: line.id, quantity: line.quantity});
  }

  if (
    isCodeDiscountTrigger &&
    skippedOfferLineForCode &&
    !Object.keys(productLinesByPercent).length &&
    codeFallbackLines.length
  ) {
    const fallbackPercentage = isStudentCodeDiscount
      ? codePercentage
      : getMaxConfiguredPercentage(codeConfig);

    if (fallbackPercentage > 0) {
      productLinesByPercent[fallbackPercentage] = codeFallbackLines;
    }
  }

  candidates.push(...Object.entries(productLinesByPercent).map(
    ([percentage, lines]) => ({
      targets: lines.map((line) => ({
        cartLine: {
          id: line.id,
          quantity: line.quantity,
        },
      })),
      value: {
        percentage: {
          value: Number(percentage),
        },
      },
    }),
  ));

  if (!candidates.length) {
    return {operations: []};
  }

  return {
    operations: [
      {
        productDiscountsAdd: {
          candidates,
          selectionStrategy: ProductDiscountSelectionStrategy.All,
        },
      },
    ],
  };
}
