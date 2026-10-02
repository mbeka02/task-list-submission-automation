ALTER TABLE `daily_delivery` ADD `attemptCount` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `daily_delivery` ADD `firstAttemptMs` integer;--> statement-breakpoint
ALTER TABLE `daily_delivery` ADD `claimToken` text;--> statement-breakpoint
ALTER TABLE `daily_delivery` ADD `claimExpiresMs` integer;--> statement-breakpoint
ALTER TABLE `daily_delivery` ADD `acknowledgedMs` integer;--> statement-breakpoint
ALTER TABLE `daily_delivery` ADD `lastError` text;