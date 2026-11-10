ALTER TABLE `connections` ADD `statements_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `connections` ADD `statement_schedule` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `kind` text DEFAULT 'transactions' NOT NULL;