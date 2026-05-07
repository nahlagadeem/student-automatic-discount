CREATE TABLE "PortalUserCustomerLink" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "customerGid" TEXT,
    "portalUserId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PortalUserCustomerLink_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PortalUserCustomerLink_shop_customerId_key"
ON "PortalUserCustomerLink"("shop", "customerId");

CREATE UNIQUE INDEX "PortalUserCustomerLink_shop_customerGid_key"
ON "PortalUserCustomerLink"("shop", "customerGid");

ALTER TABLE "PortalUserCustomerLink"
ADD CONSTRAINT "PortalUserCustomerLink_portalUserId_fkey"
FOREIGN KEY ("portalUserId") REFERENCES "PortalUser"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
