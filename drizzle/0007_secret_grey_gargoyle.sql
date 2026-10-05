-- Add operational metadata without rebuilding the parent table or touching frozen input/evidence.
ALTER TABLE `daily_brief` ADD `generationState` text DEFAULT 'pending' NOT NULL CONSTRAINT `brief_generation_state` CHECK (`generationState` IN ('pending', 'generating', 'content_ready', 'review_required'));--> statement-breakpoint
ALTER TABLE `daily_brief` ADD `generationStartedMs` integer;--> statement-breakpoint
ALTER TABLE `daily_brief` ADD `generationDeadlineMs` integer;--> statement-breakpoint
ALTER TABLE `daily_brief` ADD `generationAttemptCount` integer DEFAULT 0 NOT NULL CONSTRAINT `brief_generation_attempt_cap` CHECK (`generationAttemptCount` BETWEEN 0 AND 2);--> statement-breakpoint
ALTER TABLE `daily_brief` ADD `generationAttempts` text DEFAULT '[]' NOT NULL CONSTRAINT `brief_generation_attempt_json` CHECK (json_valid(`generationAttempts`) AND json_type(`generationAttempts`) = 'array' AND json_array_length(`generationAttempts`) = `generationAttemptCount`);--> statement-breakpoint
ALTER TABLE `daily_brief` ADD `generationKind` text CONSTRAINT `brief_generation_kind` CHECK (`generationKind` IS NULL OR `generationKind` IN ('ai', 'fallback', 'empty'));--> statement-breakpoint
ALTER TABLE `daily_brief` ADD `contentHash` text;--> statement-breakpoint
ALTER TABLE `daily_brief` ADD `generationClaimToken` text;--> statement-breakpoint
ALTER TABLE `daily_brief` ADD `generationClaimExpiresMs` integer;--> statement-breakpoint
ALTER TABLE `daily_brief` ADD `generationNextAttemptMs` integer;--> statement-breakpoint
ALTER TABLE `daily_brief` ADD `generationLastError` text;
