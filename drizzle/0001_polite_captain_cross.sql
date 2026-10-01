CREATE TABLE `message` (
	`id` text PRIMARY KEY NOT NULL,
	`appId` text NOT NULL,
	`sourceChatId` text NOT NULL,
	`sourceMessageId` text NOT NULL,
	`senderIdentity` text NOT NULL,
	`createdMs` integer NOT NULL,
	`updatedMs` integer NOT NULL,
	`deleted` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_app_source_id` ON `message` (`appId`,`sourceMessageId`);--> statement-breakpoint
CREATE TABLE `message_observation` (
	`id` text PRIMARY KEY NOT NULL,
	`messageKey` text NOT NULL,
	`fingerprint` text NOT NULL,
	`payload` text NOT NULL,
	FOREIGN KEY (`messageKey`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `observation_message_version` ON `message_observation` (`messageKey`,`fingerprint`);--> statement-breakpoint
ALTER TABLE `daily_delivery` ADD `timeZone` text DEFAULT 'Africa/Nairobi' NOT NULL;--> statement-breakpoint
ALTER TABLE `daily_delivery` ADD `cutoffMs` integer;--> statement-breakpoint
ALTER TABLE `daily_delivery` ADD `textHash` text;--> statement-breakpoint
ALTER TABLE `report_entry` ADD `observationKey` text REFERENCES message_observation(id);--> statement-breakpoint
ALTER TABLE `report_entry` ADD `senderIdentityKey` text;--> statement-breakpoint
CREATE UNIQUE INDEX `report_distinct_sender` ON `report_entry` (`deliveryId`,`senderIdentityKey`);