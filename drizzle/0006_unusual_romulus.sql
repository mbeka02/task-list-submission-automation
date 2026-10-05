CREATE TABLE `brief_entry` (
	`briefId` text NOT NULL,
	`position` integer NOT NULL,
	`senderIdentityKey` text NOT NULL,
	`observationKey` text NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`briefId`, `position`),
	FOREIGN KEY (`briefId`) REFERENCES `daily_brief`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`observationKey`) REFERENCES `message_observation`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "brief_valid_position" CHECK("brief_entry"."position" >= 0),
	CONSTRAINT "brief_valid_entry" CHECK(json_valid("brief_entry"."payload") AND coalesce(json_extract("brief_entry"."payload", '$.timeliness') IN ('on_time', 'late'), 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brief_distinct_sender` ON `brief_entry` (`briefId`,`senderIdentityKey`);--> statement-breakpoint
CREATE TABLE `daily_brief` (
	`id` text PRIMARY KEY NOT NULL,
	`appId` text NOT NULL,
	`businessDate` text NOT NULL,
	`sourceChatId` text NOT NULL,
	`destinationChatId` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`captureThroughMs` integer NOT NULL,
	`observedAtMs` integer NOT NULL,
	`inputFingerprint` text NOT NULL,
	`policyVersion` text NOT NULL,
	`templateVersion` text NOT NULL,
	`promptVersion` text NOT NULL,
	`schemaVersion` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`outputMode` text DEFAULT 'doc' NOT NULL,
	`state` text DEFAULT 'input_frozen' NOT NULL,
	CONSTRAINT "brief_valid_revision" CHECK("daily_brief"."revision" >= 1),
	CONSTRAINT "brief_valid_capture" CHECK("daily_brief"."captureThroughMs" >= 0 AND "daily_brief"."observedAtMs" >= "daily_brief"."captureThroughMs"),
	CONSTRAINT "brief_valid_provider" CHECK("daily_brief"."provider" IN ('gemini', 'deepseek')),
	CONSTRAINT "brief_doc_mode" CHECK("daily_brief"."outputMode" = 'doc'),
	CONSTRAINT "brief_input_state" CHECK("daily_brief"."state" = 'input_frozen')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `brief_business_key` ON `daily_brief` (`appId`,`businessDate`,`sourceChatId`,`destinationChatId`,`revision`);