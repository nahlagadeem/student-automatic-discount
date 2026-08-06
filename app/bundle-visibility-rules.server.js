import prisma from "./db.server";
import { INSTITUTES, getInstituteByKey } from "./institutes";

const LEGACY_BUNDLE_HANDLE = "primary-years-bundle";
const LEGACY_BUNDLE_TITLE = "Primary Years Bundle";

function normalizeHandle(value) {
  return String(value || "").trim().toLowerCase();
}

export async function ensureBundleVisibilityRuleTable() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "BundleVisibilityRule" (
      "id" SERIAL PRIMARY KEY,
      "shop" TEXT NOT NULL,
      "bundleProductId" TEXT,
      "bundleHandle" TEXT NOT NULL DEFAULT '${LEGACY_BUNDLE_HANDLE}',
      "bundleTitle" TEXT NOT NULL DEFAULT '${LEGACY_BUNDLE_TITLE}',
      "instituteKey" TEXT NOT NULL,
      "instituteLabel" TEXT NOT NULL,
      "isEnabled" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "BundleVisibilityRule"
    ADD COLUMN IF NOT EXISTS "bundleProductId" TEXT
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "BundleVisibilityRule"
    ADD COLUMN IF NOT EXISTS "bundleHandle" TEXT NOT NULL DEFAULT '${LEGACY_BUNDLE_HANDLE}'
  `);

  await prisma.$executeRawUnsafe(`
    ALTER TABLE "BundleVisibilityRule"
    ADD COLUMN IF NOT EXISTS "bundleTitle" TEXT NOT NULL DEFAULT '${LEGACY_BUNDLE_TITLE}'
  `);

  await prisma.$executeRawUnsafe(`
    DROP INDEX IF EXISTS "BundleVisibilityRule_shop_instituteKey_key"
  `);

  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "BundleVisibilityRule_shop_bundleHandle_instituteKey_key"
    ON "BundleVisibilityRule"("shop", "bundleHandle", "instituteKey")
  `);
}

export async function listBundleVisibilityRules(shop, bundleHandle) {
  await ensureBundleVisibilityRuleTable();
  const normalizedBundleHandle = normalizeHandle(bundleHandle) || LEGACY_BUNDLE_HANDLE;

  const rows = await prisma.$queryRaw`
    SELECT "instituteKey", "isEnabled"
    FROM "BundleVisibilityRule"
    WHERE "shop" = ${shop}
      AND "bundleHandle" = ${normalizedBundleHandle}
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

export async function listSavedBundleVisibilityRules(shop) {
  await ensureBundleVisibilityRuleTable();

  return prisma.$queryRaw`
    SELECT
      "id",
      "bundleProductId",
      "bundleHandle",
      "bundleTitle",
      "instituteKey",
      "instituteLabel",
      "isEnabled"
    FROM "BundleVisibilityRule"
    WHERE "shop" = ${shop}
    ORDER BY "bundleTitle" ASC, "instituteLabel" ASC
  `;
}

export async function setBundleVisibilityRule({
  shop,
  bundleProductId,
  bundleHandle,
  bundleTitle,
  instituteKey,
  isEnabled,
}) {
  await ensureBundleVisibilityRuleTable();

  const institute = getInstituteByKey(instituteKey);
  if (!institute) {
    throw new Error("Unknown institute.");
  }
  const normalizedBundleHandle = normalizeHandle(bundleHandle);
  const normalizedBundleTitle = String(bundleTitle || "").trim();
  if (!normalizedBundleHandle || !normalizedBundleTitle) {
    throw new Error("Please choose a bundle.");
  }

  await prisma.$executeRaw`
    INSERT INTO "BundleVisibilityRule" (
      "shop",
      "bundleProductId",
      "bundleHandle",
      "bundleTitle",
      "instituteKey",
      "instituteLabel",
      "isEnabled",
      "createdAt",
      "updatedAt"
    )
    VALUES (
      ${shop},
      ${String(bundleProductId || "").trim() || null},
      ${normalizedBundleHandle},
      ${normalizedBundleTitle},
      ${institute.key},
      ${institute.label},
      ${Boolean(isEnabled)},
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT ("shop", "bundleHandle", "instituteKey")
    DO UPDATE SET
      "bundleProductId" = EXCLUDED."bundleProductId",
      "bundleTitle" = EXCLUDED."bundleTitle",
      "instituteLabel" = EXCLUDED."instituteLabel",
      "isEnabled" = EXCLUDED."isEnabled",
      "updatedAt" = CURRENT_TIMESTAMP
  `;

  return {
    bundleProductId: String(bundleProductId || "").trim(),
    bundleHandle: normalizedBundleHandle,
    bundleTitle: normalizedBundleTitle,
    instituteKey: institute.key,
    instituteLabel: institute.label,
    isEnabled: Boolean(isEnabled),
  };
}

export async function isBundleVisibleForInstitute(shop, instituteKey, bundleHandle = LEGACY_BUNDLE_HANDLE) {
  await ensureBundleVisibilityRuleTable();

  const institute = getInstituteByKey(instituteKey);
  if (!institute) return false;
  const normalizedBundleHandle = normalizeHandle(bundleHandle);
  if (!normalizedBundleHandle) return false;

  const rows = await prisma.$queryRaw`
    SELECT "isEnabled"
    FROM "BundleVisibilityRule"
    WHERE "shop" = ${shop}
      AND "bundleHandle" = ${normalizedBundleHandle}
      AND "instituteKey" = ${institute.key}
    LIMIT 1
  `;

  if (!rows.length) return false;
  return Boolean(rows[0].isEnabled);
}

export async function hasAnyVisibleBundleForInstitute(shop, instituteKey) {
  await ensureBundleVisibilityRuleTable();

  const institute = getInstituteByKey(instituteKey);
  if (!institute) return false;

  const rows = await prisma.$queryRaw`
    SELECT "id"
    FROM "BundleVisibilityRule"
    WHERE "shop" = ${shop}
      AND "instituteKey" = ${institute.key}
      AND "isEnabled" = true
    LIMIT 1
  `;

  return rows.length > 0;
}
