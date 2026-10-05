-- Add operational metadata without rebuilding the populated brief table or its child foreign keys.
ALTER TABLE `daily_brief` ADD `publicationState` text DEFAULT 'pending' NOT NULL CONSTRAINT `brief_publication_state` CHECK("daily_brief"."publicationState" IN ('pending','creating','writing','verifying','sharing','verified','published','review_required'));--> statement-breakpoint
ALTER TABLE `daily_brief` ADD `documentUrl` text;--> statement-breakpoint
ALTER TABLE `daily_brief` ADD `documentHash` text CONSTRAINT `brief_document_hash` CHECK("daily_brief"."documentHash" IS NULL OR (length("daily_brief"."documentHash") = 64 AND "daily_brief"."documentHash" NOT GLOB '*[^0-9a-f]*'));--> statement-breakpoint
ALTER TABLE `daily_brief` ADD `documentRevision` integer CONSTRAINT `brief_document_revision` CHECK("daily_brief"."documentRevision" IS NULL OR "daily_brief"."documentRevision" >= 0);--> statement-breakpoint
ALTER TABLE `daily_brief` ADD `documentWriteTokens` text DEFAULT '[]' NOT NULL CONSTRAINT `brief_write_token_json` CHECK(json_valid("daily_brief"."documentWriteTokens") AND json_type("daily_brief"."documentWriteTokens") = 'array');--> statement-breakpoint
ALTER TABLE `daily_brief` ADD `publicationClaimToken` text;--> statement-breakpoint
ALTER TABLE `daily_brief` ADD `publicationClaimExpiresMs` integer CONSTRAINT `brief_publication_claim` CHECK(("daily_brief"."publicationClaimToken" IS NULL AND "daily_brief"."publicationClaimExpiresMs" IS NULL) OR ("daily_brief"."publicationClaimToken" IS NOT NULL AND "daily_brief"."publicationClaimExpiresMs" IS NOT NULL AND "daily_brief"."publicationClaimExpiresMs" >= 0));--> statement-breakpoint
ALTER TABLE `daily_brief` ADD `publicationLastError` text;--> statement-breakpoint
ALTER TABLE `daily_brief` ADD `stagingFolderToken` text;--> statement-breakpoint
ALTER TABLE `daily_brief` ADD `documentBaseUrl` text;--> statement-breakpoint
ALTER TABLE `daily_brief` ADD `announcementDeliveryId` text REFERENCES daily_delivery(id) CONSTRAINT `brief_verified_reference` CHECK("daily_brief"."publicationState" NOT IN ('verified','published') OR ("daily_brief"."documentUrl" IS NOT NULL AND "daily_brief"."documentHash" IS NOT NULL AND "daily_brief"."documentRevision" IS NOT NULL));
