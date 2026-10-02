ALTER TABLE `mcp_servers` ADD `last_ok_at` integer;--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD `last_failure_at` integer;--> statement-breakpoint
ALTER TABLE `mcp_servers` ADD `last_error` text;