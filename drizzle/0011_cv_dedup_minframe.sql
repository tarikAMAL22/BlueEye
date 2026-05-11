ALTER TABLE `settings`
  ADD COLUMN `cvMinFrameCount`        INT            NOT NULL DEFAULT 5,
  ADD COLUMN `cvCameraDedupWindowSec` DECIMAL(4, 1)  NOT NULL DEFAULT 5.0;
