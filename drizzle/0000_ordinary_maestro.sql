CREATE TABLE `daily_delivery` (
	`id` text PRIMARY KEY NOT NULL,
	`appId` text NOT NULL,
	`businessDate` text NOT NULL,
	`sourceChatId` text NOT NULL,
	`destinationChatId` text NOT NULL,
	`kind` text DEFAULT 'report' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`policyVersion` text NOT NULL,
	`text` text NOT NULL,
	`sendUuid` text NOT NULL,
	`state` text NOT NULL,
	`messageId` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_business_key` ON `daily_delivery` (`appId`,`businessDate`,`sourceChatId`,`destinationChatId`,`kind`,`revision`);--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_send_uuid` ON `daily_delivery` (`sendUuid`);--> statement-breakpoint
CREATE TABLE `report_entry` (
	`deliveryId` text NOT NULL,
	`position` integer NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`deliveryId`, `position`),
	FOREIGN KEY (`deliveryId`) REFERENCES `daily_delivery`(`id`) ON UPDATE no action ON DELETE no action
);
