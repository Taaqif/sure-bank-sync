CREATE TABLE `bank_accounts` (
	`connection_id` text NOT NULL,
	`bank_account_id` text NOT NULL,
	`name` text NOT NULL,
	`currency` text NOT NULL,
	`sure_account_id` text,
	`ignored` integer DEFAULT false NOT NULL,
	`first_seen` text NOT NULL,
	`last_seen` text NOT NULL,
	PRIMARY KEY(`connection_id`, `bank_account_id`),
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `connections` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`provider` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`schedule` text,
	`lookback_days` integer,
	`credentials` text NOT NULL,
	`options` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`connection_id` text NOT NULL,
	`user_name` text NOT NULL,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`fetched` integer DEFAULT 0 NOT NULL,
	`created` integer DEFAULT 0 NOT NULL,
	`skipped` integer DEFAULT 0 NOT NULL,
	`unmapped` integer DEFAULT 0 NOT NULL,
	`error` text,
	`log` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `runs_conn` ON `runs` (`connection_id`,`id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `synced` (
	`connection_id` text NOT NULL,
	`external_id` text NOT NULL,
	`sure_account_id` text NOT NULL,
	`sure_entry_id` text,
	`synced_at` text NOT NULL,
	PRIMARY KEY(`connection_id`, `external_id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`sure_api_key` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_name_unique` ON `users` (`name`);