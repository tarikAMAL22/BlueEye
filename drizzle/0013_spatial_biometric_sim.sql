-- Add cvSpatialBiometricSim setting and correct cvSpatialMergePx default to 100
ALTER TABLE `settings`
  ADD COLUMN `cvSpatialBiometricSim` DECIMAL(3,2) NOT NULL DEFAULT 0.30,
  MODIFY COLUMN `cvSpatialMergePx` INT NOT NULL DEFAULT 100;

-- Correct any existing rows that have the old wrong default of 400
UPDATE `settings` SET `cvSpatialMergePx` = 100 WHERE `cvSpatialMergePx` = 400;
