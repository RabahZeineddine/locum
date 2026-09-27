CREATE TABLE `initiative_links` (
	`id` text PRIMARY KEY NOT NULL,
	`initiative_id` text NOT NULL,
	`kind` text NOT NULL,
	`url` text NOT NULL,
	`label` text,
	FOREIGN KEY (`initiative_id`) REFERENCES `initiatives`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `initiative_mcp_servers` (
	`initiative_id` text NOT NULL,
	`server_name` text NOT NULL,
	FOREIGN KEY (`initiative_id`) REFERENCES `initiatives`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `initiative_mcp_servers_unq` ON `initiative_mcp_servers` (`initiative_id`,`server_name`);--> statement-breakpoint
CREATE TABLE `initiative_workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`initiative_id` text NOT NULL,
	`repo_path` text NOT NULL,
	`worktree_path` text,
	`branch` text,
	`label` text,
	FOREIGN KEY (`initiative_id`) REFERENCES `initiatives`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `initiatives` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`objective` text NOT NULL,
	`done_criteria` text NOT NULL,
	`due_at` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`goal_ref` text,
	`context_path` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `initiatives_slug_unq` ON `initiatives` (`slug`);--> statement-breakpoint
CREATE TABLE `prompt_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`prompt_id` text NOT NULL,
	`version` integer NOT NULL,
	`body` text NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`prompt_id`) REFERENCES `prompts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prompt_versions_unq` ON `prompt_versions` (`prompt_id`,`version`);--> statement-breakpoint
CREATE TABLE `prompts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`initiative_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`initiative_id`) REFERENCES `initiatives`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `prompts_name_unique` ON `prompts` (`name`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`initiative_id` text NOT NULL,
	`workspace_id` text,
	`terminal` text NOT NULL,
	`nonce` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`handoff_path` text,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`initiative_id`) REFERENCES `initiatives`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `initiative_workspaces`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_nonce_unique` ON `sessions` (`nonce`);--> statement-breakpoint
ALTER TABLE `agents` ADD `initiative_id` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `initiative_id` text;