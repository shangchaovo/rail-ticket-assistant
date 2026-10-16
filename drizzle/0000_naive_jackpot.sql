CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`name` text NOT NULL,
	`last_seen` text,
	`message` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_token_hash_unique` ON `devices` (`token_hash`);--> statement-breakpoint
CREATE INDEX `devices_owner` ON `devices` (`owner_id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`status` text NOT NULL,
	`input_json` text NOT NULL,
	`result_json` text,
	`message` text NOT NULL,
	`mode` text DEFAULT 'search' NOT NULL,
	`recheck_json` text,
	`device_id` text,
	`lease_token` text,
	`lease_until` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jobs_owner_status` ON `jobs` (`owner_id`,`status`,`created_at`);