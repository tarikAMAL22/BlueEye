ALTER TABLE `alerts` ADD `logs` json;--> statement-breakpoint
ALTER TABLE `settings` ADD `clearOnStart` boolean DEFAULT false NOT NULL;