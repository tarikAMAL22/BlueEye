-- Migration 0014: ReID + Zone Visit Tracking
-- Adds faceEncodings multi-angle column, pending_review alert status,
-- and 5 new tables: zone_visits, person_tracks, access_logs, report_cache, camera_pairs

-- 1. Add multi-encoding support to persons
ALTER TABLE `persons`
  ADD COLUMN `faceEncodings` json AFTER `faceEncoding`;

-- 2. Add pending_review to alerts status enum
ALTER TABLE `alerts`
  MODIFY COLUMN `status` enum('active','acknowledged','escalated','dismissed','pending_review') NOT NULL DEFAULT 'active';

-- 3. Zone visits tracking
CREATE TABLE `zone_visits` (
  `id` int NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `personId` int,
  `zoneId` int NOT NULL,
  `globalTrackId` varchar(36),
  `cameraId` int NOT NULL,
  `entryTime` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `exitTime` timestamp,
  `dwellSeconds` int,
  `accessGranted` boolean NOT NULL DEFAULT true
);

-- 4. Cross-camera person tracks
CREATE TABLE `person_tracks` (
  `id` varchar(36) NOT NULL PRIMARY KEY,
  `personId` int,
  `startTime` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `endTime` timestamp,
  `camerasVisited` json,
  `clothingHistogram` json
);

-- 5. Access decision audit log
CREATE TABLE `access_logs` (
  `id` int NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `personId` int,
  `zoneId` int NOT NULL,
  `cameraId` int NOT NULL,
  `timestamp` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `decision` enum('allowed','denied') NOT NULL,
  `reason` text
);

-- 6. Cached aggregated reports
CREATE TABLE `report_cache` (
  `id` int NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `reportType` enum('daily','weekly','monthly') NOT NULL,
  `entityType` enum('person','zone') NOT NULL,
  `entityId` int,
  `periodStart` timestamp NOT NULL,
  `data` json,
  `generatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 7. Camera-pair transit time config for ReID
CREATE TABLE `camera_pairs` (
  `id` int NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `cam_a_id` int NOT NULL,
  `cam_b_id` int NOT NULL,
  `max_transit_seconds` int NOT NULL DEFAULT 120,
  `distance_meters` decimal(8,2)
);
