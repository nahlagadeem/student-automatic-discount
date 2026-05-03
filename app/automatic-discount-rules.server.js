import prisma from "./db.server";

export async function ensureAutomaticDiscountRuleTable() {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "AutomaticDiscountRule" (
      "id" SERIAL PRIMARY KEY,
      "shop" TEXT NOT NULL,
      "instituteKey" TEXT NOT NULL,
      "instituteLabel" TEXT NOT NULL,
      "emailDomain" TEXT NOT NULL,
      "categoryKey" TEXT NOT NULL,
      "categoryLabel" TEXT NOT NULL,
      "percentage" INTEGER NOT NULL,
      "isActive" BOOLEAN NOT NULL DEFAULT true,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await prisma.$executeRawUnsafe(`
    CREATE UNIQUE INDEX IF NOT EXISTS "AutomaticDiscountRule_shop_instituteKey_categoryKey_key"
    ON "AutomaticDiscountRule"("shop", "instituteKey", "categoryKey")
  `);
}
