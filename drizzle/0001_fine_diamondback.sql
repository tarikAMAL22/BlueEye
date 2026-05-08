CREATE TABLE `accessRules` (
	`id` int AUTO_INCREMENT NOT NULL,
	`personId` int NOT NULL,
	`zoneId` int NOT NULL,
	`allowed` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `accessRules_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `alerts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`personId` int,
	`cameraId` int NOT NULL,
	`zoneId` int NOT NULL,
	`faceSnapshotUrl` varchar(512),
	`bestFrameSnapshotUrl` varchar(512),
	`confidence` decimal(5,2) NOT NULL,
	`status` enum('active','acknowledged','escalated','dismissed') NOT NULL DEFAULT 'active',
	`threatLevel` enum('low','medium','high','critical') NOT NULL DEFAULT 'medium',
	`timestamp` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `alerts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `cameras` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`rtspUrl` varchar(512) NOT NULL,
	`location` text,
	`zoneId` int,
	`status` enum('online','offline','maintenance') NOT NULL DEFAULT 'offline',
	`lastSeen` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `cameras_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` int AUTO_INCREMENT NOT NULL,
	`personId` int,
	`cameraId` int NOT NULL,
	`zoneId` int NOT NULL,
	`faceSnapshotUrl` varchar(512),
	`bestFrameSnapshotUrl` varchar(512),
	`confidence` decimal(5,2) NOT NULL,
	`eventType` enum('recognized','unknown','alert') NOT NULL DEFAULT 'unknown',
	`timestamp` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `persons` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`role` varchar(255) NOT NULL,
	`photoUrl` varchar(512),
	`zonePermissions` json,
	`activityHistory` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `persons_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`platformName` varchar(255) NOT NULL DEFAULT 'BlueEye',
	`alertThreshold` decimal(5,2) NOT NULL DEFAULT '0.75',
	`notificationPreferences` json,
	`retentionDays` int NOT NULL DEFAULT 90,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `settings_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `zones` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`description` text,
	`threatLevel` enum('low','medium','high','critical') NOT NULL DEFAULT 'medium',
	`accessRules` json,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `zones_id` PRIMARY KEY(`id`)
);
