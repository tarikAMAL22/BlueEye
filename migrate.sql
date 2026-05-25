-- Add detectionType to persons (skip if exists)
SET @exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'persons' AND COLUMN_NAME = 'detectionType'
);
SET @sql = IF(@exists = 0,
  "ALTER TABLE persons ADD COLUMN detectionType VARCHAR(20) DEFAULT 'face'",
  "SELECT 'detectionType already exists' AS info"
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Backfill existing rows
UPDATE persons SET detectionType = 'body_only' WHERE name LIKE 'body-only-%';
UPDATE persons SET detectionType = 'face' WHERE detectionType IS NULL OR (detectionType = 'face' AND name NOT LIKE 'body-only-%');

-- Create motions table if not exists
CREATE TABLE IF NOT EXISTS motions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  cameraId INT NOT NULL,
  zoneId INT NOT NULL DEFAULT 1,
  frameSnapshotUrl VARCHAR(500),
  motionArea INT NOT NULL DEFAULT 0,
  personsDetected INT NOT NULL DEFAULT 0,
  detectedAt DATETIME NOT NULL DEFAULT NOW(),
  INDEX idx_motions_camera (cameraId),
  INDEX idx_motions_detected (detectedAt)
);

SELECT 'Migration complete' AS status;
