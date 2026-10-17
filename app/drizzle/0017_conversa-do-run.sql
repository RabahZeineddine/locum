CREATE TABLE `run_conversations` (
	`run_id` text PRIMARY KEY NOT NULL,
	`falas` text DEFAULT '[]' NOT NULL,
	`sessao` text,
	`trava` text,
	`alvo` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `runs` ADD `conversa_usd` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `conversa_tokens` integer DEFAULT 0 NOT NULL;