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
  mode?: string;
  codePercentage?: number;
  automaticConfig?: RuleConfig | null;
  codeConfig?: RuleConfig | null;
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
  ipadPercentage: 0,
  macPercentage: 0,
  accessoriesPercentage: 0,
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
      percentage: clampPercentage(rule.percentage, 0),
    }))
    .filter((rule) => rule.categoryKey && rule.percentage > 0);
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
    isCollectionMember(product.mac) ? tierConfig.macPercentage : 0,
    isCollectionMember(product.ipad) ? tierConfig.ipadPercentage : 0,
    isCollectionMember(product.accessories) ? tierConfig.accessoriesPercentage : 0,
    isCollectionMember(product.iphone) ? tierConfig.iphonePercentage : 0,
    isCollectionMember(product.appleWatch) ? tierConfig.appleWatchPercentage : 0,
    isCollectionMember(product.tvHome) ? tierConfig.tvHomePercentage : 0,
    isCollectionMember(product.airpods) ? tierConfig.airpodsPercentage : 0,
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
  const codePercentage = clampPercentage(rawConfig.codePercentage, 0);
  const codeConfig = isCodeWithAutomaticExclusions && rawConfig.codeConfig ? rawConfig.codeConfig : rawConfig;
  const automaticConfig =
    (isStudentCodeDiscount || isCodeWithAutomaticExclusions) && rawConfig.automaticConfig
      ? rawConfig.automaticConfig
      : null;
  const productLinesByPercent: Record<number, {id: string; quantity: number}[]> =
    {};

  for (const line of input.cart.lines) {
    if (line.merchandise.__typename !== "ProductVariant") continue;

    const product = line.merchandise.product;
    const automaticPercentage = automaticConfig
      ? getLinePercentageFromConfig(input, product, automaticConfig)
      : 0;
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

  const candidates = Object.entries(productLinesByPercent).map(
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
