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

  const config = readTierConfig(input);
  const productLinesByPercent: Record<number, {id: string; quantity: number}[]> =
    {};

  for (const line of input.cart.lines) {
    if (line.merchandise.__typename !== "ProductVariant") continue;

    const product = line.merchandise.product;
    const percentage = Math.max(
      product.mac.some((membership) => membership.isMember) ? config.macPercentage : 0,
      product.ipad.some((membership) => membership.isMember) ? config.ipadPercentage : 0,
      product.accessories.some((membership) => membership.isMember) ? config.accessoriesPercentage : 0,
      product.iphone.some((membership) => membership.isMember) ? config.iphonePercentage : 0,
      product.appleWatch.some((membership) => membership.isMember) ? config.appleWatchPercentage : 0,
      product.tvHome.some((membership) => membership.isMember) ? config.tvHomePercentage : 0,
      product.airpods.some((membership) => membership.isMember) ? config.airpodsPercentage : 0,
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
