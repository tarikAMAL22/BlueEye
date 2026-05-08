-- BlueEye migration 0009 — CV pipeline settings
-- Adds columns that were previously hardcoded in config.py or read from env vars.
-- All new columns have safe defaults that match the previous hardcoded values.

ALTER TABLE `settings`
  ADD COLUMN `cvLandmarkMinPoints`   INT            NOT NULL DEFAULT 25    COMMENT 'Min face landmark count to accept a detection',
  ADD COLUMN `cvBiometricMergeSim`   DECIMAL(3,2)   NOT NULL DEFAULT 0.90  COMMENT 'Min similarity to merge two trackers biometrically',
  ADD COLUMN `cvSpatialMergePx`      INT            NOT NULL DEFAULT 400   COMMENT 'Max centroid distance (px) for spatial tracker merge',
  ADD COLUMN `cvInactivityTimeoutSec` DECIMAL(4,1)  NOT NULL DEFAULT 5.0   COMMENT 'Flush a tracker after N seconds without detection',
  ADD COLUMN `cvFrameQueueSize`      INT            NOT NULL DEFAULT 200   COMMENT 'Bounded frame queue capacity (oldest frame evicted when full)',
  ADD COLUMN `cvDetectionWorkers`    INT            NOT NULL DEFAULT 2     COMMENT 'Number of parallel face-detection worker threads';
