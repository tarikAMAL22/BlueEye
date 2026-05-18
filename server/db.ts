import { eq, desc, and, like, gte, lte, ne, isNotNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { InsertUser, users, cameras, zones, persons, alerts, events, settings, accessRules, movements, cvWorkerConfig, Camera, Zone, Person, Alert, Event, Setting, InsertCamera, InsertZone, InsertPerson, InsertAlert, InsertEvent, InsertSetting, InsertAccessRule, Movement, CvWorkerConfig, InsertCvWorkerConfig, accessGroups, groupZoneAccess, personGroupMembership, InsertAccessGroup, AccessGroup } from "../drizzle/schema";
import { ENV } from './_core/env';

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = 'admin';
      updateSet.role = 'admin';
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export async function getUsers() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(users).orderBy(desc(users.createdAt));
}

export async function updateUser(id: number, data: Partial<InsertUser>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.update(users).set(data).where(eq(users.id, id));
}

// ============ CAMERA QUERIES ============

export async function getCameras() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(cameras).orderBy(desc(cameras.createdAt));
}

export async function getCameraById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(cameras).where(eq(cameras.id, id)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function createCamera(data: InsertCamera) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  const result = await db.insert(cameras).values(data);
  return result;
}

export async function updateCamera(id: number, data: Partial<InsertCamera>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.update(cameras).set(data).where(eq(cameras.id, id));
}

export async function deleteCamera(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.delete(cameras).where(eq(cameras.id, id));
}

// ============ ZONE QUERIES ============

export async function getZones() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(zones).orderBy(desc(zones.createdAt));
}

export async function getZoneById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(zones).where(eq(zones.id, id)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function createZone(data: InsertZone) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.insert(zones).values(data);
}

export async function updateZone(id: number, data: Partial<InsertZone>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.update(zones).set(data).where(eq(zones.id, id));
}

export async function deleteZone(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.delete(zones).where(eq(zones.id, id));
}

// ============ PERSON QUERIES ============

export async function getPersons() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(persons).orderBy(desc(persons.createdAt));
}

export async function getPersonById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(persons).where(eq(persons.id, id)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function createPerson(data: InsertPerson) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.insert(persons).values(data);
}

export async function updatePerson(id: number, data: Partial<InsertPerson>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  // If photo is changing, clear the encoding to force re-analysis
  const updateData = { ...data };
  if (data.photoUrl) {
    updateData.faceEncoding = null;
  }
  
  return db.update(persons).set(updateData).where(eq(persons.id, id));
}

export async function deletePerson(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.delete(persons).where(eq(persons.id, id));
}

// ============ ALERT QUERIES ============

// Explicit column sets — avoids crashing on schema columns not yet migrated to the DB
// (e.g. detectionType on alerts, zonePermissions/activityHistory on persons).
const SAFE_ALERT_COLS = {
  id:                   alerts.id,
  personId:             alerts.personId,
  cameraId:             alerts.cameraId,
  zoneId:               alerts.zoneId,
  faceSnapshotUrl:      alerts.faceSnapshotUrl,
  bestFrameSnapshotUrl: alerts.bestFrameSnapshotUrl,
  confidence:           alerts.confidence,
  status:               alerts.status,
  threatLevel:          alerts.threatLevel,
  detectionType:        alerts.detectionType,
  faceQuality:          alerts.faceQuality,
  logs:                 alerts.logs,
  metadata:             alerts.metadata,
  timestamp:            alerts.timestamp,
  createdAt:            alerts.createdAt,
} as const;

const SAFE_PERSON_COLS = {
  id:            persons.id,
  name:          persons.name,
  role:          persons.role,
  photoUrl:      persons.photoUrl,
  isBlacklisted: persons.isBlacklisted,
} as const;

export async function getAlerts(filters: {
  limit?: number;
  status?: string;
  zoneId?: number;
  personId?: number;
  startDate?: string;
  endDate?: string;
  threatLevel?: string;
  detectionType?: 'FACE' | 'NO_FACE';
  faceQuality?: 'CLEAR' | 'UNCLEAR' | 'NO_FACE';
} = {}) {
  const db = await getDb();
  if (!db) return [];
  
  const limit = filters.limit ?? 50;
  
  // Explicit column selection — avoids crashing on schema columns not yet
  // migrated to the actual DB (e.g. detectionType, zonePermissions, activityHistory).
  let query = db.select({
    alert: SAFE_ALERT_COLS,
    person: SAFE_PERSON_COLS,
  }).from(alerts)
    .leftJoin(persons, eq(alerts.personId, persons.id));
  
  const conditions = [];
  if (filters.status && filters.status !== "all") {
    conditions.push(eq(alerts.status, filters.status as any));
  }
  if (filters.zoneId) {
    conditions.push(eq(alerts.zoneId, filters.zoneId));
  }
  if (filters.personId) {
    conditions.push(eq(alerts.personId, filters.personId));
  }
  if (filters.startDate) {
    conditions.push(gte(alerts.timestamp, new Date(filters.startDate)));
  }
  if (filters.endDate) {
    conditions.push(lte(alerts.timestamp, new Date(filters.endDate)));
  }
  if (filters.threatLevel && filters.threatLevel !== 'all') {
    conditions.push(eq(alerts.threatLevel, filters.threatLevel as any));
  }
  if (filters.detectionType) {
    conditions.push(eq(alerts.detectionType, filters.detectionType));
  }
  if (filters.faceQuality) {
    conditions.push(eq(alerts.faceQuality, filters.faceQuality as any));
  }
  
  if (conditions.length > 0) {
    // @ts-ignore
    query = query.where(and(...conditions));
  }


  
  const results = await query.orderBy(desc(alerts.timestamp)).limit(limit);
  
  // Flatten result to match frontend expectation (alert with .person property)
  return results.map(r => ({
    ...r.alert,
    person: r.person
  }));
}

export async function getAlertsByPerson(personId: number, limit: number = 10) {
  const db = await getDb();
  if (!db) return [];
  return db.select(SAFE_ALERT_COLS).from(alerts).where(eq(alerts.personId, personId)).orderBy(desc(alerts.timestamp)).limit(limit);
}

export async function getAlertById(id: number) {
  const db = await getDb();
  if (!db) return undefined;

  const result = await db.select({
    alert: SAFE_ALERT_COLS,
    person: SAFE_PERSON_COLS,
  }).from(alerts)
    .leftJoin(persons, eq(alerts.personId, persons.id))
    .where(eq(alerts.id, id))
    .limit(1);

  if (result.length === 0) return undefined;

  return {
    ...result[0].alert,
    person: result[0].person
  };
}

export async function createAlert(data: InsertAlert) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.insert(alerts).values(data);
}

export async function updateAlert(id: number, data: Partial<InsertAlert>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.update(alerts).set(data).where(eq(alerts.id, id));
}

export async function addAlertLog(id: number, action: string, details?: string) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  const alert = await getAlertById(id);
  if (!alert) throw new Error("Alert not found");
  
  const logs = (alert.logs as any[]) || [];
  logs.push({
    timestamp: new Date().toISOString(),
    action,
    details
  });
  
  return db.update(alerts).set({ logs }).where(eq(alerts.id, id));
}

// ============ EVENT QUERIES ============

export async function getEvents(limit: number = 100, offset: number = 0) {
  const db = await getDb();
  if (!db) return { events: [], total: 0 };
  
  const results = await db.select({
    event: events,
    person: persons,
    alert: alerts,
  })
  .from(events)
  .leftJoin(persons, eq(events.personId, persons.id))
  .leftJoin(alerts, eq(events.alertId, alerts.id))
  .orderBy(desc(events.timestamp))
  .limit(limit)
  .offset(offset);

  return { 
    events: results.map(r => ({ 
      ...r.event, 
      person: r.person,
      alertMetadata: r.alert?.metadata 
    })), 
    total: results.length 
  };
}

export async function getEventById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(events).where(eq(events.id, id)).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function createEvent(data: InsertEvent) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.insert(events).values(data);
}

// ============ SETTINGS QUERIES ============

export async function getSettings() {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(settings).limit(1);
  return result.length > 0 ? result[0] : undefined;
}

export async function updateSettings(data: Partial<InsertSetting>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  // Update the first (and only) settings record
  const existing = await getSettings();
  if (existing) {
    return db.update(settings).set(data).where(eq(settings.id, existing.id));
  } else {
    // Create default settings if none exist
    return db.insert(settings).values({ ...data, platformName: "BlueEye" });
  }
}


export async function clearAlertsAndEvents() {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  
  // Clear alerts, events and movements tables
  await db.delete(alerts);
  await db.delete(events);
  await db.delete(movements);

  console.log("[Database] Cleared alerts, events and movements logs.");
  return { success: true };
}

export async function fullSystemReset() {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  try {
    // 1. Clear Tables in order to respect constraints
    console.log("[System Reset] Clearing alerts...");
    await db.delete(alerts);
    console.log("[System Reset] Clearing events...");
    await db.delete(events);
    console.log("[System Reset] Clearing movements...");
    await db.delete(movements);
    console.log("[System Reset] Clearing persons...");
    await db.delete(persons);
    
    console.log("[System Reset] Completed Full System Reset. Upload files preserved.");
    return { success: true };
  } catch (error) {
    console.error("[System Reset] Error during reset:", error);
    throw error;
  }
}

export async function mergePersonRecords(oldPersonId: number, newPersonId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  // 1. Update all alerts
  await db.update(alerts).set({ personId: newPersonId }).where(eq(alerts.personId, oldPersonId));
  
  // 2. Update all events
  await db.update(events).set({ personId: newPersonId }).where(eq(events.personId, oldPersonId));
  
  // 3. Update all access rules
  await db.update(accessRules).set({ personId: newPersonId }).where(eq(accessRules.personId, oldPersonId));

  // 4. Delete the old (temporary) person record
  await db.delete(persons).where(eq(persons.id, oldPersonId));

  console.log(`[Database] Merged person ${oldPersonId} into ${newPersonId}.`);
  return { success: true };
}

export async function getPotentialMatches(personId: number, customThreshold?: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");

  const target = await getPersonById(personId);
  if (!target || !target.faceEncoding) return [];

  const targetEncoding = target.faceEncoding as number[];
  
  // Get threshold: custom > settings > default 0.5
  const sysSettings = await getSettings();
  const threshold = customThreshold !== undefined 
    ? customThreshold 
    : (sysSettings ? parseFloat(sysSettings.biometricThreshold as string) : 0.5);

  // Get all persons with encodings, excluding the target itself
  const candidates = await db.select().from(persons).where(
    and(
      ne(persons.id, personId),
      isNotNull(persons.faceEncoding)
    )
  );

  const matches = candidates.map(c => {
    if (!c.faceEncoding || !Array.isArray(c.faceEncoding)) return null;
    const cEncoding = c.faceEncoding as number[];
    
    // Safety check: ensure both encodings have the same length (usually 128)
    if (targetEncoding.length !== cEncoding.length) return null;
    
    // Euclidean distance
    const dist = Math.sqrt(targetEncoding.reduce((acc, cur, i) => acc + Math.pow(cur - cEncoding[i], 2), 0));
    
    // Map distance to score (0-100)
    // distance 0.0 -> 100%, distance 1.0 -> 0%
    const score = Math.max(0, Math.min(100, Math.round((1.0 - dist) * 100)));
    
    if (dist < threshold) {
      return { ...c, matchScore: score };
    }
    return null;
  }).filter(Boolean) as (Person & { matchScore: number })[];

  // Sort by score descending
  return matches.sort((a, b) => b.matchScore - a.matchScore);
}

// ============ MOVEMENT QUERIES ============

// Explicit column set — skips suppressionReason/suppressionDetails until DB migration runs.
// Add those columns back after: ALTER TABLE movements ADD COLUMN suppressionReason VARCHAR(32) NULL,
//   ADD COLUMN suppressionDetails JSON NULL;
const SAFE_MOVEMENT_COLS = {
  id:           movements.id,
  cameraId:     movements.cameraId,
  zoneId:       movements.zoneId,
  trackerId:    movements.trackerId,
  frameUrls:    movements.frameUrls,
  bestFrameUrl: movements.bestFrameUrl,
  faceCropUrl:  movements.faceCropUrl,
  faceCount:    movements.faceCount,
  frameCount:   movements.frameCount,
  alertId:      movements.alertId,
  timestamp:    movements.timestamp,
  createdAt:    movements.createdAt,
} as const;

// After running the ALTER TABLE above, swap SAFE_MOVEMENT_COLS for movements (all columns).

export async function getMovementById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  // Try with new columns first; fall back to safe set if migration not yet applied
  try {
    const rows = await db.select().from(movements).where(eq(movements.id, id)).limit(1);
    return rows[0];
  } catch {
    const rows = await db.select(SAFE_MOVEMENT_COLS).from(movements).where(eq(movements.id, id)).limit(1);
    return rows[0];
  }
}

export async function getMovementByAlertId(alertId: number) {
  const db = await getDb();
  if (!db) return undefined;
  try {
    const rows = await db.select().from(movements).where(eq(movements.alertId, alertId)).limit(1);
    return rows[0];
  } catch {
    const rows = await db.select(SAFE_MOVEMENT_COLS).from(movements).where(eq(movements.alertId, alertId)).limit(1);
    return rows[0];
  }
}

export async function getMovements(filters: {
  limit?: number;
  cameraId?: number;
  zoneId?: number;
  alertId?: number;
  startDate?: string;
  endDate?: string;
} = {}) {
  const db = await getDb();
  if (!db) return [];

  const limit = filters.limit ?? 100;
  const conditions = [];
  if (filters.cameraId)  conditions.push(eq(movements.cameraId,  filters.cameraId));
  if (filters.zoneId)    conditions.push(eq(movements.zoneId,    filters.zoneId));
  if (filters.alertId)   conditions.push(eq(movements.alertId,   filters.alertId));
  if (filters.startDate) conditions.push(gte(movements.timestamp, new Date(filters.startDate)));
  if (filters.endDate)   conditions.push(lte(movements.timestamp, new Date(filters.endDate)));

  const buildQuery = (sel: any) => {
    let q = db.select(sel).from(movements);
    if (conditions.length > 0) q = (q as any).where(and(...conditions));
    return (q as any).orderBy(desc(movements.timestamp)).limit(limit);
  };

  try {
    return await buildQuery(movements) as any[];
  } catch {
    return await buildQuery(SAFE_MOVEMENT_COLS) as any[];
  }
}

// ============ ACCESS RULES QUERIES ============

export async function getAccessRulesByPerson(personId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(accessRules).where(eq(accessRules.personId, personId));
}

export async function getAccessRulesByZone(zoneId: number) {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(accessRules).where(eq(accessRules.zoneId, zoneId));
}

export async function createAccessRule(data: InsertAccessRule) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.insert(accessRules).values(data);
}

export async function updateAccessRule(id: number, data: Partial<InsertAccessRule>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.update(accessRules).set(data).where(eq(accessRules.id, id));
}

// ============ CV WORKER CONFIG QUERIES ============

const CV_CONFIG_DEFAULTS: Omit<InsertCvWorkerConfig, 'id' | 'updatedAt' | 'updatedBy'> = {
  alertCooldownSeconds:       5,
  biometricMemorySeconds:     20,
  biometricDistanceThreshold: "0.40" as any,
  trackingRadiusPx:           80,
  detectionBufferSeconds:     "1.0" as any,
  maxPresenceSeconds:         "8.0" as any,
  frameAnalysisIntervalMs:    150,
  minFacePixels:              50,
  faceMinHeightPx:            20,
  landmarkMinPoints:          10,
  imageDownscaleFactor:       "0.50" as any,
  upsampleTimes:              2,
  recognitionTolerance:       "0.50" as any,
};

export async function getCvWorkerConfig(): Promise<CvWorkerConfig | null> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(cvWorkerConfig).orderBy(desc(cvWorkerConfig.id)).limit(1);
  return rows[0] ?? null;
}

export async function upsertCvWorkerConfig(
  data: Partial<Omit<InsertCvWorkerConfig, 'id' | 'updatedAt'>>,
  updatedBy?: number,
): Promise<void> {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  await db.insert(cvWorkerConfig).values({ ...CV_CONFIG_DEFAULTS, ...data, updatedBy: updatedBy ?? null });
}

export async function resetCvWorkerConfig(updatedBy?: number): Promise<void> {
  return upsertCvWorkerConfig(CV_CONFIG_DEFAULTS, updatedBy);
}

// ============ DASHBOARD EXTENDED QUERIES ============

export async function getDashboardSystemStatus() {
  const db = await getDb();
  if (!db) return { cvWorkerAlive: false, camerasOnline: 0, camerasTotal: 0, pendingAlerts: 0 };

  let cvWorkerAlive = false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const cvWorkerUrl = process.env.CV_WORKER_URL ?? "http://localhost:5000";
    const res = await fetch(`${cvWorkerUrl}/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    cvWorkerAlive = res.ok;
  } catch { /* offline */ }

  const [cameraList, pendingList] = await Promise.all([
    db.select({ status: cameras.status }).from(cameras),
    db.select({ id: alerts.id }).from(alerts).where(eq(alerts.status, 'active')),
  ]);

  return {
    cvWorkerAlive,
    camerasOnline: cameraList.filter(c => c.status === 'online').length,
    camerasTotal: cameraList.length,
    pendingAlerts: pendingList.length,
  };
}

export async function getDashboardTodayBreakdown() {
  const db = await getDb();
  if (!db) return { totalToday: 0, recognizedToday: 0, unknownToday: 0, unknownPercent: 0 };

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const rows = await db
    .select({ eventType: events.eventType })
    .from(events)
    .where(gte(events.timestamp, today));

  const totalToday = rows.length;
  const recognizedToday = rows.filter(r => r.eventType === 'recognized' || r.eventType === 'recognition').length;
  const unknownToday = rows.filter(r => r.eventType === 'unknown').length;
  const unknownPercent = totalToday > 0 ? Math.round((unknownToday / totalToday) * 100) : 0;

  return { totalToday, recognizedToday, unknownToday, unknownPercent };
}

export async function getDashboardZoneStatus() {
  const db = await getDb();
  if (!db) return [];

  const [zoneList, activeAlertList, cameraList] = await Promise.all([
    db.select().from(zones),
    db.select({ zoneId: alerts.zoneId }).from(alerts).where(eq(alerts.status, 'active')),
    db.select({ zoneId: cameras.zoneId, status: cameras.status }).from(cameras),
  ]);

  return zoneList.map(zone => ({
    ...zone,
    activeAlerts: activeAlertList.filter(a => a.zoneId === zone.id).length,
    cameraCount: cameraList.filter(c => c.zoneId === zone.id).length,
  }));
}

export async function getDashboardHourlyActivity() {
  const db = await getDb();
  if (!db) return Array.from({ length: 24 }, (_, h) => ({ hour: h, total: 0, recognized: 0, unknown: 0 }));

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ eventType: events.eventType, timestamp: events.timestamp })
    .from(events)
    .where(gte(events.timestamp, cutoff));

  const hourMap = Array.from({ length: 24 }, (_, h) => ({ hour: h, total: 0, recognized: 0, unknown: 0 }));
  for (const row of rows) {
    const h = new Date(row.timestamp).getHours();
    hourMap[h].total++;
    if (row.eventType === 'recognized' || row.eventType === 'recognition') hourMap[h].recognized++;
    else if (row.eventType === 'unknown') hourMap[h].unknown++;
  }
  return hourMap;
}

export async function getDashboardSystemHealth() {
  const db = await getDb();
  if (!db) {
    return { personsTotal: 0, personsWithValidEncoding: 0, alertsTotal: 0, eventsTotal: 0, avgConfidence: 0, lastEventAt: null, recentEvents: [] };
  }

  const [[{ n: pTotal }], [{ n: aTotal }], [{ n: eTotal }], [avgRow], recentRaw] = await Promise.all([
    db.select({ n: sql<string>`count(*)` }).from(persons),
    db.select({ n: sql<string>`count(*)` }).from(alerts),
    db.select({ n: sql<string>`count(*)` }).from(events),
    db.select({ avg: sql<string>`AVG(CAST(confidence AS DECIMAL(10,2)))` }).from(alerts),
    db.select({ event: events, person: persons })
      .from(events)
      .leftJoin(persons, eq(events.personId, persons.id))
      .orderBy(desc(events.timestamp))
      .limit(3),
  ]);

  const personsWithEnc = await db
    .select({ faceEncoding: persons.faceEncoding })
    .from(persons)
    .where(isNotNull(persons.faceEncoding));

  const personsWithValidEncoding = personsWithEnc.filter(p => {
    try {
      const enc = typeof p.faceEncoding === 'string' ? JSON.parse(p.faceEncoding) : p.faceEncoding;
      return Array.isArray(enc) && enc.length === 128;
    } catch { return false; }
  }).length;

  return {
    personsTotal: Number(pTotal ?? 0),
    personsWithValidEncoding,
    alertsTotal: Number(aTotal ?? 0),
    eventsTotal: Number(eTotal ?? 0),
    avgConfidence: Math.round(parseFloat(avgRow?.avg ?? '0') || 0),
    lastEventAt: recentRaw[0]?.event.timestamp ?? null,
    recentEvents: recentRaw.map(r => ({
      id: r.event.id,
      cameraId: r.event.cameraId,
      eventType: r.event.eventType,
      personName: r.person?.name ?? null,
      timestamp: r.event.timestamp,
    })),
  };
}

// ============ DASHBOARD STATS ============

// ============ ACCESS GROUP QUERIES ============

export async function listAccessGroups() {
  const db = await getDb();
  if (!db) return [];
  return db.select().from(accessGroups).orderBy(accessGroups.name);
}

export async function getAccessGroupById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(accessGroups).where(eq(accessGroups.id, id)).limit(1);
  return rows[0];
}

export async function createAccessGroup(data: InsertAccessGroup) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.insert(accessGroups).values(data);
}

export async function updateAccessGroup(id: number, data: Partial<InsertAccessGroup>) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.update(accessGroups).set(data).where(eq(accessGroups.id, id));
}

export async function deleteAccessGroup(id: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.delete(accessGroups).where(eq(accessGroups.id, id));
}

export async function getGroupZones(groupId: number) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({
    access: groupZoneAccess,
    zone: zones,
  }).from(groupZoneAccess)
    .leftJoin(zones, eq(groupZoneAccess.zoneId, zones.id))
    .where(eq(groupZoneAccess.groupId, groupId));
  return rows.map(r => ({ ...r.access, zone: r.zone }));
}

export async function addZoneToGroup(groupId: number, zoneId: number, schedule?: { startTime?: string; endTime?: string; daysOfWeek?: string }) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.insert(groupZoneAccess).values({
    groupId,
    zoneId,
    startTime:  schedule?.startTime  ?? null,
    endTime:    schedule?.endTime    ?? null,
    daysOfWeek: schedule?.daysOfWeek ?? "1234567",
  });
}

export async function removeZoneFromGroup(groupId: number, zoneId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.delete(groupZoneAccess).where(
    and(eq(groupZoneAccess.groupId, groupId), eq(groupZoneAccess.zoneId, zoneId))
  );
}

export async function getGroupMembers(groupId: number) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({
    membership: personGroupMembership,
    person: persons,
  }).from(personGroupMembership)
    .leftJoin(persons, eq(personGroupMembership.personId, persons.id))
    .where(eq(personGroupMembership.groupId, groupId));
  return rows.map(r => ({ ...r.membership, person: r.person }));
}

export async function getPersonGroups(personId: number) {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({
    membership: personGroupMembership,
    group: accessGroups,
  }).from(personGroupMembership)
    .leftJoin(accessGroups, eq(personGroupMembership.groupId, accessGroups.id))
    .where(eq(personGroupMembership.personId, personId));
  return rows.map(r => ({ ...r.membership, group: r.group }));
}

export async function addPersonToGroup(personId: number, groupId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.insert(personGroupMembership).values({ personId, groupId });
}

export async function removePersonFromGroup(personId: number, groupId: number) {
  const db = await getDb();
  if (!db) throw new Error("Database not available");
  return db.delete(personGroupMembership).where(
    and(eq(personGroupMembership.personId, personId), eq(personGroupMembership.groupId, groupId))
  );
}

export async function getAllPersonGroupMemberships() {
  const db = await getDb();
  if (!db) return [];
  const rows = await db.select({
    personId: personGroupMembership.personId,
    groupId:  personGroupMembership.groupId,
    groupName:  accessGroups.name,
    groupColor: accessGroups.color,
  }).from(personGroupMembership)
    .leftJoin(accessGroups, eq(personGroupMembership.groupId, accessGroups.id));
  return rows;
}

// ============ DASHBOARD STATS ============

export async function getDashboardStats() {
  const db = await getDb();
  if (!db) return { totalCameras: 0, activeCameras: 0, totalZones: 0, todayRecognitions: 0, unknownDetections: 0, activeAlerts: 0 };
  
  const cameraList = await db.select().from(cameras);
  const zoneList = await db.select().from(zones);
  const activeCameraCount = cameraList.filter(c => c.status === 'online').length;
  
  // Get today's events with persons
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayEvents = await db.select({
    event: events,
    person: persons,
  })
  .from(events)
  .leftJoin(persons, eq(events.personId, persons.id))
  .where(gte(events.timestamp, today));

  const recognizedCount = todayEvents.filter(e => e.event.eventType === 'recognized' || e.event.eventType === 'recognition').length;
  const unknownCount = todayEvents.filter(e => e.event.eventType === 'unknown').length;
  const blacklistCount = todayEvents.filter(e => e.person?.isBlacklisted || e.event.eventType === 'alert').length;
  
  // Get active alerts
  const activeAlertList = await db.select().from(alerts).where(eq(alerts.status, 'active'));
  
  return {
    totalCameras: cameraList.length,
    activeCameras: activeCameraCount,
    totalZones: zoneList.length,
    todayRecognitions: recognizedCount,
    unknownDetections: unknownCount,
    activeAlerts: activeAlertList.length,
    blacklistDetections: blacklistCount,
  };
}
