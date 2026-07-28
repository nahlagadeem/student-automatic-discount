import prisma from "./db.server";
import { INSTITUTES, getInstituteByKey } from "./institutes";

export async function ensureBundleVisibilityRuleTable() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "BundleVisibilityRule" (
      "id" SERIAL PRIMARY KEY,
      "shop" TEXT NOT NULL,
      "instituteKey" TEXT NOT NULL,
      "instituteLabel" TEXT NOT NULL,
      "isEnabled" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "BundleVisibilityRule_shop_instituteKey_key"
    ON "BundleVisibilityRule"("shop", "instituteKey")
  `);
}

export async function listBundleVisibilityRules(shop) {
  await ensureBundleVisibilityRuleTable();

  const rows = await prisma.$queryRaw`
    SELECT "instituteKey", "isEnabled"
    FROM "BundleVisibilityRule"
    WHERE "shop" = ${shop}
  `;
  const overridesByInstituteKey = new Map(
    rows.map((row) => [String(row.instituteKey || "").trim(), Boolean(row.isEnabled)]),
  );

  return INSTITUTES.map((institute) => ({
    ...institute,
    isEnabled: overridesByInstituteKey.has(institute.key)
      ? overridesByInstituteKey.get(institute.key)
      : false,
    isDefault: !overridesByInstituteKey.has(institute.key),
  }));
}

export async function setBundleVisibilityRule({ shop, instituteKey, isEnabled }) {
  await ensureBundleVisibilityRuleTable();

  const institute = getInstituteByKey(instituteKey);
  if (!institute) {
    throw new Error("Unknown institute.");
  }

  await prisma.$executeRaw`
    INSERT INTO "BundleVisibilityRule" (
      "shop",
      "instituteKey",
      "instituteLabel",
      "isEnabled",
      "createdAt",
      "updatedAt"
    )
    VALUES (
      ${shop},
      ${institute.key},
      ${institute.label},
      ${Boolean(isEnabled)},
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT ("shop", "instituteKey")
    DO UPDATE SET
      "instituteLabel" = EXCLUDED."instituteLabel",
      "isEnabled" = EXCLUDED."isEnabled",
      "updatedAt" = CURRENT_TIMESTAMP
  `;

  return {
    instituteKey: institute.key,
    instituteLabel: institute.label,
    isEnabled: Boolean(isEnabled),
  };
}

export async function isBundleVisibleForInstitute(shop, instituteKey) {
  await ensureBundleVisibilityRuleTable();

  const institute = getInstituteByKey(instituteKey);
  if (!institute) return false;

  const rows = await prisma.$queryRaw`
    SELECT "isEnabled"
    FROM "BundleVisibilityRule"
    WHERE "shop" = ${shop}
      AND "instituteKey" = ${institute.key}
    LIMIT 1
  `;

  if (!rows.length) return false;
  return Boolean(rows[0].isEnabled);
}
