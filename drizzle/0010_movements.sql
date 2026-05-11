-- BlueEye migration 0010 — movements table
-- Logs every face detection tracker regardless of alert cooldown or suppression.
-- Stores a flipbook of frame URLs for playback in the Motion Detections screen.

CREATE TABLE IF NOT EXISTS `movements` (
  `id`            INT            NOT NULL AUTO_INCREMENT,
  `cameraId`      INT            NOT NULL,
  `zoneId`        INT            NOT NULL DEFAULT 1,
  `trackerId`     VARCHAR(64)    NOT NULL,
  `frameUrls`     JSON           NULL     COMMENT 'Array of /uploads/clip_xxx.jpg URLs for flipbook',
  `bestFrameUrl`  VARCHAR(512)   NULL,
  `faceCount`     INT            NOT NULL DEFAULT 0,
  `frameCount`    INT            NOT NULL DEFAULT 0,
  `alertId`       INT            NULL     COMMENT 'NULL if suppressed by cooldown',
  `timestamp`     TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `createdAt`     TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `idx_movements_camera`    (`cameraId`),
  INDEX `idx_movements_timestamp` (`timestamp`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
