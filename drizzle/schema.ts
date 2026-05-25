import { decimal, int, mysqlEnum, mysqlTable, text, timestamp, varchar, boolean, json, float, index } from "drizzle-orm/mysql-core";
import { sql } from "drizzle-orm";

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Manus OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * Cameras table: stores RTSP camera information
 */
export const cameras = mysqlTable("cameras", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  rtspUrl: varchar("rtspUrl", { length: 512 }).notNull(),
  location: text("location"),
  zoneId: int("zoneId"),
  status: mysqlEnum("status", ["online", "offline", "maintenance"]).default("offline").notNull(),
  lastSeen: timestamp("lastSeen"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Camera = typeof cameras.$inferSelect;
export type InsertCamera = typeof cameras.$inferInsert;

/**
 * Zones table: security zones with threat levels
 */
export const zones = mysqlTable("zones", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  threatLevel: mysqlEnum("threatLevel", ["low", "medium", "high", "critical"]).default("medium").notNull(),
  accessRules: json("accessRules").$type<{ allowedRoles: string[]; timeRestrictions?: { startTime: string; endTime: string } }[]>(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Zone = typeof zones.$inferSelect;
export type InsertZone = typeof zones.$inferInsert;

/**
 * Persons table: known individuals in the registry
 */
export const persons = mysqlTable("persons", {
  id: int("id").autoincrement().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  role: varchar("role", { length: 255 }).notNull(),
  photoUrl: varchar("photoUrl", { length: 512 }),
  faceEncoding: json("faceEncoding").$type<number[]>(),
  faceEncodings: json("faceEncodings").$type<number[][]>(),
  isBlacklisted: boolean("isBlacklisted").default(false).notNull(),
  detectionType: varchar("detectionType", { length: 20 }).default("face"),
  zonePermissions: json("zonePermissions").$type<{ zoneId: number; allowed: boolean }[]>(),
  activityHistory: json("activityHistory").$type<{ timestamp: number; action: string }[]>(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Person = typeof persons.$inferSelect;
export type InsertPerson = typeof persons.$inferInsert;

/**
 * Alerts table: real-time detection events
 */
export const alerts = mysqlTable("alerts", {
  id: int("id").autoincrement().primaryKey(),
  personId: int("personId"),
  cameraId: int("cameraId").notNull(),
  zoneId: int("zoneId").notNull(),
  faceSnapshotUrl: varchar("faceSnapshotUrl", { length: 512 }),
  bestFrameSnapshotUrl: varchar("bestFrameSnapshotUrl", { length: 512 }),
  confidence: decimal("confidence", { precision: 5, scale: 2 }).notNull(),
  status: mysqlEnum("status", ["active", "acknowledged", "escalated", "dismissed", "pending_review", "completed"]).default("active").notNull(),
  threatLevel: mysqlEnum("threatLevel", ["low", "medium", "high", "critical"]).default("medium").notNull(),
  detectionType: mysqlEnum("detectionType", ["FACE", "NO_FACE"]).default("FACE").notNull(),
  faceQuality: mysqlEnum("faceQuality", ["CLEAR", "UNCLEAR", "NO_FACE"]).default("CLEAR").notNull(),
  logs: json("logs").$type<{ timestamp: string; action: string; details?: string }[]>(),
  metadata: json("metadata"), // For multi-face detection and other extras
  timestamp: timestamp("timestamp").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Alert = typeof alerts.$inferSelect;
export type InsertAlert = typeof alerts.$inferInsert;

/**
 * Events table: historical log of all recognition events
 */
export const events = mysqlTable("events", {
  id: int("id").autoincrement().primaryKey(),
  personId: int("personId"),
  alertId: int("alertId"),
  cameraId: int("cameraId").notNull(),
  zoneId: int("zoneId").notNull(),
  faceSnapshotUrl: varchar("faceSnapshotUrl", { length: 512 }),
  bestFrameSnapshotUrl: varchar("bestFrameSnapshotUrl", { length: 512 }),
  confidence: decimal("confidence", { precision: 5, scale: 2 }).notNull(),
  eventType: mysqlEnum("eventType", ["recognition", "unknown", "alert", "identity_correction", "false_positive", "no_face"]).default("recognition").notNull(),
  payload: json("payload"),
  timestamp: timestamp("timestamp").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type Event = typeof events.$inferSelect;
export type InsertEvent = typeof events.$inferInsert;

/**
 * AccessRules table: per-zone access permissions for persons
 */
export const accessRules = mysqlTable("accessRules", {
  id: int("id").autoincrement().primaryKey(),
  personId: int("personId").notNull(),
  zoneId: int("zoneId").notNull(),
  allowed: boolean("allowed").default(false).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type AccessRule = typeof accessRules.$inferSelect;
export type InsertAccessRule = typeof accessRules.$inferInsert;

/**
 * AccessGroups table: named groups for zone access control
 */
export const accessGroups = mysqlTable("access_groups", {
  id:          int("id").autoincrement().primaryKey(),
  name:        varchar("name", { length: 100 }).notNull(),
  description: varchar("description", { length: 255 }),
  color:       varchar("color", { length: 7 }).default("#00F5FF"),
  isDefault:   boolean("isDefault").default(false).notNull(),
  createdAt:   timestamp("createdAt").defaultNow().notNull(),
  updatedAt:   timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type AccessGroup = typeof accessGroups.$inferSelect;
export type InsertAccessGroup = typeof accessGroups.$inferInsert;

/**
 * GroupZoneAccess table: which zones a group can access (with optional schedule)
 */
export const groupZoneAccess = mysqlTable("group_zone_access", {
  id:         int("id").autoincrement().primaryKey(),
  groupId:    int("groupId").notNull().references(() => accessGroups.id, { onDelete: "cascade" }),
  zoneId:     int("zoneId").notNull().references(() => zones.id, { onDelete: "cascade" }),
  startTime:  varchar("startTime", { length: 5 }),
  endTime:    varchar("endTime", { length: 5 }),
  daysOfWeek: varchar("daysOfWeek", { length: 20 }).default("1234567"),
  createdAt:  timestamp("createdAt").defaultNow().notNull(),
});

export type GroupZoneAccess = typeof groupZoneAccess.$inferSelect;

/**
 * PersonGroupMembership table: persons belonging to access groups
 */
export const personGroupMembership = mysqlTable("person_group_membership", {
  id:       int("id").autoincrement().primaryKey(),
  personId: int("personId").notNull().references(() => persons.id, { onDelete: "cascade" }),
  groupId:  int("groupId").notNull().references(() => accessGroups.id, { onDelete: "cascade" }),
  addedAt:  timestamp("addedAt").defaultNow().notNull(),
});

export type PersonGroupMembership = typeof personGroupMembership.$inferSelect;

/**
 * Movements table: every face detection tracker, including cooldown-suppressed ones.
 * frameUrls is a JSON array of /uploads/clip_xxx.jpg paths for the flipbook player.
 */
export const movements = mysqlTable("movements", {
  id:           int("id").autoincrement().primaryKey(),
  cameraId:     int("cameraId").notNull(),
  zoneId:       int("zoneId").notNull().default(1),
  trackerId:    varchar("trackerId", { length: 64 }).notNull(),
  frameUrls:    json("frameUrls").$type<string[]>(),
  bestFrameUrl: varchar("bestFrameUrl", { length: 512 }),
  faceCropUrl:  varchar("faceCropUrl",  { length: 512 }),
  faceCount:    int("faceCount").notNull().default(0),
  frameCount:   int("frameCount").notNull().default(0),
  detectionType: mysqlEnum("detectionType", ["FACE", "BODY", "MOTION"]).default("MOTION").notNull(),
  alertId:           int("alertId"),
  suppressionReason: varchar("suppressionReason", { length: 32 }),
  suppressionDetails: json("suppressionDetails").$type<{
    secondsAgo?: number;
    secondsRemaining?: number;
    windowSeconds?: number;
    cooldownSeconds?: number;
  }>(),
  timestamp:    timestamp("timestamp").defaultNow().notNull(),
  createdAt:    timestamp("createdAt").defaultNow().notNull(),
});

export type Movement = typeof movements.$inferSelect;
export type InsertMovement = typeof movements.$inferInsert;

/**
 * CV Worker Config table: live-tunable detection sensitivity parameters.
 * Append-only (ORDER BY id DESC LIMIT 1 = current config). Reload every 30s in cv_worker.
 */
export const cvWorkerConfig = mysqlTable("cv_worker_config", {
  id: int("id").autoincrement().primaryKey(),

  // ── Consecutive-detection cooldown ─────────────────────────────────────
  alertCooldownSeconds:       int("alert_cooldown_seconds").notNull().default(5),
  biometricMemorySeconds:     int("biometric_memory_seconds").notNull().default(20),
  biometricDistanceThreshold: decimal("biometric_distance_threshold", { precision: 3, scale: 2 }).notNull().default("0.40"),

  // ── Spatial tracker ─────────────────────────────────────────────────────
  trackingRadiusPx: int("tracking_radius_px").notNull().default(80),

  // ── Buffer / presence windows ───────────────────────────────────────────
  detectionBufferSeconds: decimal("detection_buffer_seconds", { precision: 3, scale: 1 }).notNull().default("1.0"),
  maxPresenceSeconds:     decimal("max_presence_seconds",     { precision: 4, scale: 1 }).notNull().default("8.0"),

  // ── Frame analysis ──────────────────────────────────────────────────────
  frameAnalysisIntervalMs: int("frame_analysis_interval_ms").notNull().default(150),
  minFacePixels:           int("min_face_pixels").notNull().default(50),

  // ── Face detection filters (replaces hardcodes in cv_worker.py) ─────────
  faceMinHeightPx:      int("face_min_height_px").notNull().default(20),
  landmarkMinPoints:    int("landmark_min_points").notNull().default(10),
  imageDownscaleFactor: decimal("image_downscale_factor", { precision: 3, scale: 2 }).notNull().default("0.50"),
  upsampleTimes:        int("upsample_times").notNull().default(2),
  recognitionTolerance: decimal("recognition_tolerance", { precision: 3, scale: 2 }).notNull().default("0.50"),

  updatedAt: timestamp("updated_at").defaultNow().onUpdateNow(),
  updatedBy: int("updated_by"),
});

export type CvWorkerConfig = typeof cvWorkerConfig.$inferSelect;
export type InsertCvWorkerConfig = typeof cvWorkerConfig.$inferInsert;

/**
 * Settings table: system-wide configuration
 */
export const settings = mysqlTable("settings", {
  id: int("id").autoincrement().primaryKey(),
  platformName: varchar("platformName", { length: 255 }).default("BlueEye").notNull(),
  alertThreshold: decimal("alertThreshold", { precision: 5, scale: 2 }).default("0.75").notNull(),
  notificationPreferences: json("notificationPreferences").$type<{ emailAlerts: boolean; pushAlerts: boolean }>(),
  retentionDays: int("retentionDays").default(90).notNull(),
  clearOnStart: boolean("clearOnStart").default(false).notNull(),
  testMode: boolean("testMode").default(false).notNull(),
  biometricThreshold: decimal("biometricThreshold", { precision: 3, scale: 2 }).default("0.50").notNull(),
  cvMotionClipMaxFrames: int("cvMotionClipMaxFrames").default(20).notNull(),
  cvFlipbookInterval: int("cvFlipbookInterval").default(500).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export type Setting = typeof settings.$inferSelect;
export type InsertSetting = typeof settings.$inferInsert;

/**
 * ZoneVisits table: per-visit dwell tracking per person per zone
 */
export const zoneVisits = mysqlTable("zone_visits", {
  id: int("id").autoincrement().primaryKey(),
  personId: int("personId"),
  zoneId: int("zoneId").notNull(),
  globalTrackId: varchar("globalTrackId", { length: 36 }),
  cameraId: int("cameraId").notNull(),
  entryTime: timestamp("entryTime").defaultNow().notNull(),
  exitTime: timestamp("exitTime"),
  dwellSeconds: int("dwellSeconds"),
  accessGranted: boolean("accessGranted").default(true).notNull(),
});

export type ZoneVisit = typeof zoneVisits.$inferSelect;
export type InsertZoneVisit = typeof zoneVisits.$inferInsert;

/**
 * PersonTracks table: cross-camera journey tracking for a single visit
 */
export const personTracks = mysqlTable("person_tracks", {
  id: varchar("id", { length: 36 }).primaryKey(),
  personId: int("personId"),
  startTime: timestamp("startTime").defaultNow().notNull(),
  endTime: timestamp("endTime"),
  camerasVisited: json("camerasVisited").$type<{ camId: number; zoneId: number; timestamp: string }[]>(),
  clothingHistogram: json("clothingHistogram").$type<number[]>(),
});

export type PersonTrack = typeof personTracks.$inferSelect;
export type InsertPersonTrack = typeof personTracks.$inferInsert;

/**
 * AccessLogs table: per-access decision audit trail
 */
export const accessLogs = mysqlTable("access_logs", {
  id: int("id").autoincrement().primaryKey(),
  personId: int("personId"),
  zoneId: int("zoneId").notNull(),
  cameraId: int("cameraId").notNull(),
  timestamp: timestamp("timestamp").defaultNow().notNull(),
  decision: mysqlEnum("decision", ["allowed", "denied"]).notNull(),
  reason: text("reason"),
});

export type AccessLog = typeof accessLogs.$inferSelect;
export type InsertAccessLog = typeof accessLogs.$inferInsert;

/**
 * ReportCache table: cached aggregated report data
 */
export const reportCache = mysqlTable("report_cache", {
  id: int("id").autoincrement().primaryKey(),
  reportType: mysqlEnum("reportType", ["daily", "weekly", "monthly"]).notNull(),
  entityType: mysqlEnum("entityType", ["person", "zone"]).notNull(),
  entityId: int("entityId"),
  periodStart: timestamp("periodStart").notNull(),
  data: json("data"),
  generatedAt: timestamp("generatedAt").defaultNow().notNull(),
});

export type ReportCache = typeof reportCache.$inferSelect;

/**
 * CameraPairs table: max transit time between camera pairs for ReID
 */
export const cameraPairs = mysqlTable("camera_pairs", {
  id: int("id").autoincrement().primaryKey(),
  camAId: int("cam_a_id").notNull(),
  camBId: int("cam_b_id").notNull(),
  maxTransitSeconds: int("max_transit_seconds").notNull().default(120),
  distanceMeters: decimal("distance_meters", { precision: 8, scale: 2 }),
});

export type CameraPair = typeof cameraPairs.$inferSelect;

/**
 * Motions table: raw MOG2 motion events logged by cv_worker every 5s
 */
export const motions = mysqlTable('motions', {
  id:               int('id').autoincrement().primaryKey(),
  cameraId:         int('cameraId').notNull(),
  zoneId:           int('zoneId').notNull().default(1),
  frameSnapshotUrl: varchar('frameSnapshotUrl', { length: 500 }),
  frame2Url:        varchar('frame2Url', { length: 500 }),
  frame3Url:        varchar('frame3Url', { length: 500 }),
  motionArea:       int('motionArea').notNull().default(0),
  personsDetected:  int('personsDetected').notNull().default(0),
  detectedAt:       timestamp('detectedAt').notNull().default(sql`NOW()`),
}, (table) => ({
  cameraIdx:   index('idx_motions_camera').on(table.cameraId),
  zoneIdx:     index('idx_motions_zone').on(table.zoneId),
  detectedIdx: index('idx_motions_detected').on(table.detectedAt),
}))

export type Motion = typeof motions.$inferSelect;
export type InsertMotion = typeof motions.$inferInsert;
