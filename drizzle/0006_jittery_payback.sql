ALTER TABLE `events` MODIFY COLUMN `eventType` enum('recognized','unknown','alert','identity_correction') NOT NULL DEFAULT 'unknown';--> statement-breakpoint
ALTER TABLE `events` ADD `alertId` int;--> statement-breakpoint
ALTER TABLE `events` ADD `payload` json;