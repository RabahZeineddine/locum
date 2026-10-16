CREATE TABLE `usage_provider_daily` (
	`day` text NOT NULL,
	`provider` text NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`tokens` integer DEFAULT 0 NOT NULL,
	`requests` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_provider_daily_unq` ON `usage_provider_daily` (`day`,`provider`);