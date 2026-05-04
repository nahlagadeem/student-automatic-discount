import {
  DiscountClass,
  ProductDiscountSelectionStrategy,
  CartInput,
  CartLinesDiscountsGenerateRunResult,
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

type RuleConfig = {
  version?: number;
  rules?: {
    instituteKey?: string;
    instituteLabel?: string;
    emailDomain?: string;
    categoryKey?: string;
    categoryLabel?: string;
    percentage?: number;
  }[];
};

type MatchedRule = {
  categoryKey: string;
  percentage: number;
};

type ProductLineProduct = Extract<
  CartInput["cart"]["lines"][number]["merchandise"],
  { __typename: "ProductVariant" }
>["product"];

const DEFAULT_CONFIG: TierConfig = {
  ipadPercentage: 8,
  macPercentage: 13,
  accessoriesPercentage: 5,
  iphonePercentage: 0,
  appleWatchPercentage: 0,
  tvHomePercentage: 0,
  airpodsPercentage: 0,
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

function readTierConfig(input: CartInput): TierConfig {
  const rawValue = input.discount.metafield?.value;
  if (!rawValue) return DEFAULT_CONFIG;

  try {
    const parsed = JSON.parse(rawValue) as Partial<TierConfig>;
    return {
      ipadPercentage: clampPercentage(parsed.ipadPercentage, DEFAULT_CONFIG.ipadPercentage),
      macPercentage: clampPercentage(parsed.macPercentage, DEFAULT_CONFIG.macPercentage),
      accessoriesPercentage: clampPercentage(parsed.accessoriesPercentage, DEFAULT_CONFIG.accessoriesPercentage),
      iphonePercentage: clampPercentage(parsed.iphonePercentage, DEFAULT_CONFIG.iphonePercentage),
      appleWatchPercentage: clampPercentage(parsed.appleWatchPercentage, DEFAULT_CONFIG.appleWatchPercentage),
      tvHomePercentage: clampPercentage(parsed.tvHomePercentage, DEFAULT_CONFIG.tvHomePercentage),
      airpodsPercentage: clampPercentage(parsed.airpodsPercentage, DEFAULT_CONFIG.airpodsPercentage),
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function readRuleConfig(input: CartInput): MatchedRule[] {
  const rawValue = input.discount.metafield?.value;
  if (!rawValue) return [];

  try {
    const parsed = JSON.parse(rawValue) as RuleConfig;
    if (!Array.isArray(parsed.rules)) return [];

    const buyerInstituteKey = getBuyerInstituteKeyFromTags(input);
    if (!buyerInstituteKey) return [];

    return parsed.rules
      .filter((rule) => String(rule.instituteKey || "").trim() === buyerInstituteKey)
      .map((rule) => ({
        categoryKey: String(rule.categoryKey || "").trim(),
        percentage: clampPercentage(rule.percentage, 0),
      }))
      .filter((rule) => rule.categoryKey && rule.percentage > 0);
  } catch {
    return [];
  }
}

function isCollectionMember(memberships: { isMember: boolean }[]): boolean {
  return memberships.some((membership) => membership.isMember);
}

function getLinePercentageFromRules(product: ProductLineProduct, rules: MatchedRule[]): number {
  if (!rules.length) return 0;

  let maxPercentage = 0;
  for (const rule of rules) {
    const isMatch =
      (rule.categoryKey === "ipad" && isCollectionMember(product.ipad)) ||
      (rule.categoryKey === "mac" && isCollectionMember(product.mac)) ||
      (rule.categoryKey === "accessories" && isCollectionMember(product.accessories)) ||
      (rule.categoryKey === "iphone" && isCollectionMember(product.iphone)) ||
      (rule.categoryKey === "apple-watch" && isCollectionMember(product.appleWatch)) ||
      (rule.categoryKey === "tv-home" && isCollectionMember(product.tvHome)) ||
      (rule.categoryKey === "airpods" && isCollectionMember(product.airpods));

    if (isMatch) {
      maxPercentage = Math.max(maxPercentage, rule.percentage);
    }
  }

  return maxPercentage;
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

  const matchedRules = readRuleConfig(input);
  const config = readTierConfig(input);
  const productLinesByPercent: Record<number, {id: string; quantity: number}[]> =
    {};

  for (const line of input.cart.lines) {
    if (line.merchandise.__typename !== "ProductVariant") continue;

    const product = line.merchandise.product;
    const percentage = matchedRules.length
      ? getLinePercentageFromRules(product, matchedRules)
      : Math.max(
          isCollectionMember(product.mac) ? config.macPercentage : 0,
          isCollectionMember(product.ipad) ? config.ipadPercentage : 0,
          isCollectionMember(product.accessories) ? config.accessoriesPercentage : 0,
          isCollectionMember(product.iphone) ? config.iphonePercentage : 0,
          isCollectionMember(product.appleWatch) ? config.appleWatchPercentage : 0,
          isCollectionMember(product.tvHome) ? config.tvHomePercentage : 0,
          isCollectionMember(product.airpods) ? config.airpodsPercentage : 0,
          0,
        );

    if (percentage <= 0) continue;
    if (!productLinesByPercent[percentage]) {
      productLinesByPercent[percentage] = [];
    }
    productLinesByPercent[percentage].push({id: line.id, quantity: line.quantity});
  }

  const candidates = Object.entries(productLinesByPercent).map(
    ([percentage, lines]) => ({
      message: `${percentage}% category discount`,
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
  );

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
