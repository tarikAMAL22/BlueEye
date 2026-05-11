import { eq, desc, and, like, gte, lte, ne, isNotNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { InsertUser, users, cameras, zones, persons, alerts, events, settings, accessRules, movements, Camera, Zone, Person, Alert, Event, Setting, InsertCamera, InsertZone, InsertPerson, InsertAlert, InsertEvent, InsertSetting, InsertAccessRule, Movement } from "../drizzle/schema";
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

export async function getAlerts(filters: { 
  limit?: number; 
  status?: string; 
  zoneId?: number; 
  personId?: number; 
  startDate?: string; 
  endDate?: string; 
} = {}) {
  const db = await getDb();
  if (!db) return [];
  
  const limit = filters.limit ?? 50;
  
  // Select both alert and person data
  let query = db.select({
    alert: alerts,
    person: persons,
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
  return db.select().from(alerts).where(eq(alerts.personId, personId)).orderBy(desc(alerts.timestamp)).limit(limit);
}

export async function getAlertById(id: number) {
  const db = await getDb();
  if (!db) return undefined;
  
  const result = await db.select({
    alert: alerts,
    person: persons,
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

import * as fs from "fs";
import * as path from "path";

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
    
    // 2. Clear Uploads Folder
    // Use an absolute path based on the project root
    const projectRoot = path.resolve(process.cwd());
    const uploadDir = path.join(projectRoot, "client", "public", "uploads");
    
    console.log(`[System Reset] Cleaning uploads directory: ${uploadDir}`);
    if (fs.existsSync(uploadDir)) {
      const files = fs.readdirSync(uploadDir);
      let count = 0;
      for (const file of files) {
        if (file === ".gitkeep") continue;
        try {
          fs.unlinkSync(path.join(uploadDir, file));
          count++;
        } catch (err) {
          console.warn(`[System Reset] Failed to delete file ${file}:`, err);
        }
      }
      console.log(`[System Reset] Deleted ${count} files.`);
    } else {
      console.warn(`[System Reset] Upload directory not found at ${uploadDir}`);
    }

    console.log("[System Reset] Completed Full System Reset.");
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

export async function getMovementById(id: number): Promise<Movement | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(movements).where(eq(movements.id, id)).limit(1);
  return rows[0];
}

export async function getMovementByAlertId(alertId: number): Promise<Movement | undefined> {
  const db = await getDb();
  if (!db) return undefined;
  const rows = await db.select().from(movements).where(eq(movements.alertId, alertId)).limit(1);
  return rows[0];
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
  if (filters.cameraId) conditions.push(eq(movements.cameraId, filters.cameraId));
  if (filters.zoneId)   conditions.push(eq(movements.zoneId,   filters.zoneId));
  if (filters.alertId)  conditions.push(eq(movements.alertId,  filters.alertId));
  if (filters.startDate) conditions.push(gte(movements.timestamp, new Date(filters.startDate)));
  if (filters.endDate)   conditions.push(lte(movements.timestamp, new Date(filters.endDate)));

  // @ts-ignore
  let q = db.select().from(movements);
  if (conditions.length > 0) q = (q as any).where(and(...conditions));
  return (q as any).orderBy(desc(movements.timestamp)).limit(limit) as Promise<Movement[]>;
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
