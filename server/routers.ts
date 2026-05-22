import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router, protectedProcedure, adminProcedure } from "./_core/trpc";
import { z } from "zod";
import * as db from "./db";
import { motionsRouter } from "./routers/motions";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { ENV } from "./_core/env";
import { sql } from "drizzle-orm";

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),

  // ============ DASHBOARD ============
  dashboard: router({
    stats: protectedProcedure.query(async () => {
      return db.getDashboardStats();
    }),
    systemStatus: protectedProcedure.query(async () => {
      return db.getDashboardSystemStatus();
    }),
    todayBreakdown: protectedProcedure.query(async () => {
      return db.getDashboardTodayBreakdown();
    }),
    zoneStatus: protectedProcedure.query(async () => {
      return db.getDashboardZoneStatus();
    }),
    hourlyActivity: protectedProcedure.query(async () => {
      return db.getDashboardHourlyActivity();
    }),
    systemHealth: protectedProcedure.query(async () => {
      return db.getDashboardSystemHealth();
    }),
  }),

  // ============ CAMERAS ============
  cameras: router({
    list: protectedProcedure.query(async () => {
      return db.getCameras();
    }),
    
    getById: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        return db.getCameraById(input.id);
      }),
    
    create: adminProcedure
      .input(z.object({
        name: z.string().min(1),
        rtspUrl: z.string().min(1),
        location: z.string().optional(),
        zoneId: z.number().optional(),
        status: z.enum(["online", "offline", "maintenance"]).optional(),
      }))
      .mutation(async ({ input }) => {
        return db.createCamera({
          name: input.name,
          rtspUrl: input.rtspUrl,
          location: input.location,
          zoneId: input.zoneId,
          status: input.status || "offline",
        });
      }),
    
    update: adminProcedure
      .input(z.object({
        id: z.number(),
        name: z.string().optional(),
        rtspUrl: z.string().optional(),
        location: z.string().optional(),
        zoneId: z.number().optional(),
        status: z.enum(["online", "offline", "maintenance"]).optional(),
      }))
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        return db.updateCamera(id, data);
      }),
    
    delete: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        return db.deleteCamera(input.id);
      }),
  }),

  // ============ ZONES ============
  zones: router({
    list: protectedProcedure.query(async () => {
      return db.getZones();
    }),
    
    getById: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        return db.getZoneById(input.id);
      }),
    
    create: adminProcedure
      .input(z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        threatLevel: z.enum(["low", "medium", "high", "critical"]).default("medium"),
        accessRules: z.any().optional(),
      }))
      .mutation(async ({ input }) => {
        return db.createZone({
          name: input.name,
          description: input.description,
          threatLevel: input.threatLevel,
          accessRules: input.accessRules,
        });
      }),
    
    update: adminProcedure
      .input(z.object({
        id: z.number(),
        name: z.string().optional(),
        description: z.string().optional(),
        threatLevel: z.enum(["low", "medium", "high", "critical"]).optional(),
        accessRules: z.any().optional(),
      }))
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        return db.updateZone(id, data);
      }),
    
    delete: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        return db.deleteZone(input.id);
      }),
  }),

  // ============ PERSONS (PERSON REGISTRY) ============
  persons: router({
    list: protectedProcedure.query(async () => {
      return db.getPersons();
    }),
    
    getById: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        return db.getPersonById(input.id);
      }),
    
    create: adminProcedure
      .input(z.object({
        name: z.string().min(1),
        role: z.string().min(1),
        photoUrl: z.string().optional(),
        photoBase64: z.string().optional(),
        isBlacklisted: z.boolean().optional(),
        zonePermissions: z.any().optional(),
      }))
      .mutation(async ({ input }) => {
        let finalPhotoUrl = input.photoUrl;
        
        if (input.photoBase64) {
          const matches = input.photoBase64.match(/^data:image\/([A-Za-z-+\/]+);base64,(.+)$/);
          if (matches && matches.length === 3) {
            const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
            const buffer = Buffer.from(matches[2], "base64");
            const filename = `face_manual_${crypto.randomUUID()}.${ext}`;
            const uploadDir = path.join(process.cwd(), "client/public/uploads");
            
            if (!fs.existsSync(uploadDir)) {
              fs.mkdirSync(uploadDir, { recursive: true });
            }
            
            fs.writeFileSync(path.join(uploadDir, filename), buffer);
            finalPhotoUrl = `/uploads/${filename}`;
          }
        }
        
        const result = await db.createPerson({
          name: input.name,
          role: input.role,
          photoUrl: finalPhotoUrl,
          zonePermissions: input.zonePermissions,
          activityHistory: [],
          isBlacklisted: input.isBlacklisted ?? false,
        });
        const newId = (result as any).insertId as number;
        if (finalPhotoUrl) {
          fetch(`${ENV.cvWorkerUrl}/api/encode-person`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ personId: newId }),
          }).catch(e => console.warn("[Router] Background encoding failed for person", newId, e));
        }
        return { insertId: newId };
      }),
    
    update: adminProcedure
      .input(z.object({
        id: z.number(),
        name: z.string().optional(),
        role: z.string().optional(),
        photoUrl: z.string().optional(),
        photoBase64: z.string().optional(),
        isBlacklisted: z.boolean().optional(),
        zonePermissions: z.any().optional(),
      }))
      .mutation(async ({ input }) => {
        const { id, photoBase64, ...data } = input;
        let finalPhotoUrl = input.photoUrl;

        if (photoBase64) {
          const matches = photoBase64.match(/^data:image\/([A-Za-z-+\/]+);base64,(.+)$/);
          if (matches && matches.length === 3) {
            const ext = matches[1] === 'jpeg' ? 'jpg' : matches[1];
            const buffer = Buffer.from(matches[2], "base64");
            const filename = `face_manual_update_${crypto.randomUUID()}.${ext}`;
            const uploadDir = path.join(process.cwd(), "client/public/uploads");

            if (!fs.existsSync(uploadDir)) {
              fs.mkdirSync(uploadDir, { recursive: true });
            }

            fs.writeFileSync(path.join(uploadDir, filename), buffer);
            finalPhotoUrl = `/uploads/${filename}`;
          }
        }

        // Strip undefined values so Drizzle doesn't overwrite existing DB
        // columns with NULL — critical for photoUrl when no new photo is sent
        const updatePayload: Record<string, unknown> = Object.fromEntries(
          Object.entries({ ...data, photoUrl: finalPhotoUrl })
            .filter(([, v]) => v !== undefined)
        );
        const updated = await db.updatePerson(id, updatePayload as any);
        if (finalPhotoUrl) {
          fetch(`${ENV.cvWorkerUrl}/api/encode-person`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ personId: id }),
          }).catch(e => console.warn("[Router] Background encoding failed for person", id, e));
        }
        return updated;
      }),
    
    delete: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        return db.deletePerson(input.id);
      }),

    getPotentialMatches: protectedProcedure
      .input(z.object({ 
        personId: z.number(),
        threshold: z.number().optional()
      }))
      .query(async ({ input }) => {
        return db.getPotentialMatches(input.personId, input.threshold);
      }),

    mergePersons: protectedProcedure
      .input(z.object({ sourceId: z.number(), targetId: z.number() }))
      .mutation(async ({ input }) => {
        return db.mergePersonRecords(input.sourceId, input.targetId);
      }),

    computeEncoding: protectedProcedure
      .input(z.object({ personId: z.number() }))
      .mutation(async ({ input }) => {
        const response = await fetch(`${ENV.cvWorkerUrl}/api/encode-person`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ personId: input.personId }),
        });
        if (!response.ok) {
          const err = await response.json() as any;
          throw new Error(err.error || "Encoding failed");
        }
        return await response.json();
      }),
  }),

  // ============ ALERTS (LIVE ALERTS FEED) ============
  alerts: router({
    list: protectedProcedure
      .input(z.object({
        limit: z.number().default(50),
        status: z.string().optional(),
        zoneId: z.number().optional(),
        personId: z.number().optional(),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        threatLevel: z.string().optional(),
        detectionType: z.enum(['FACE', 'NO_FACE']).optional(),
        faceQuality: z.enum(['CLEAR', 'UNCLEAR', 'NO_FACE']).optional(),
      }))
      .query(async ({ input }) => {
        return db.getAlerts(input);
      }),
    
    getByPerson: protectedProcedure
      .input(z.object({ personId: z.number(), limit: z.number().default(10) }))
      .query(async ({ input }) => {
        return db.getAlertsByPerson(input.personId, input.limit);
      }),
    
    getById: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        return db.getAlertById(input.id);
      }),
    
    create: protectedProcedure
      .input(z.object({
        personId: z.number().optional(),
        cameraId: z.number(),
        zoneId: z.number(),
        faceSnapshotUrl: z.string().optional(),
        bestFrameSnapshotUrl: z.string().optional(),
        confidence: z.number(),
        status: z.enum(["active", "acknowledged", "escalated", "dismissed"]).default("active"),
        threatLevel: z.enum(["low", "medium", "high", "critical"]).default("medium"),
      }))
      .mutation(async ({ input }) => {
        return db.createAlert(input as any);
      }),

    countFaces: protectedProcedure
      .input(z.object({ imageUrl: z.string() }))
      .mutation(async ({ input }) => {
        try {
          const response = await fetch(`${ENV.cvWorkerUrl}/api/count-faces`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ imageUrl: input.imageUrl }),
          });
          if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error || "Failed to count faces");
          }
          return await response.json() as { faceCount: number; locations: { x: number; y: number; w: number; h: number }[] };
        } catch (error: any) {
          throw new Error(`CV Worker communication error: ${error.message}`);
        }
      }),

    notHim: protectedProcedure
      .input(z.object({ alertId: z.number() }))
      .mutation(async ({ input }) => {
        try {
          const response = await fetch(`${ENV.cvWorkerUrl}/api/re-match`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ alertId: input.alertId }),
          });
          if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error || "Failed to re-match alert");
          }
          return await response.json();
        } catch (error: any) {
          throw new Error(`CV Worker communication error: ${error.message}`);
        }
      }),
    
    updateStatus: protectedProcedure
      .input(z.object({
        id: z.number(),
        status: z.enum(["active", "acknowledged", "escalated", "dismissed"]),
      }))
      .mutation(async ({ input }) => {
        await db.updateAlert(input.id, { status: input.status });
        await db.addAlertLog(input.id, "STATUS_CHANGE", `Status changed to ${input.status}`);
        return { success: true };
      }),
      
    assignPerson: protectedProcedure
      .input(z.object({
        alertId: z.number(),
        personId: z.number(),
      }))
      .mutation(async ({ input }) => {
        try {
          const alert = await db.getAlertById(input.alertId);
          if (!alert) throw new Error("Alert not found");

          const oldPersonId = alert.personId;
          const person = await db.getPersonById(input.personId);
          
          console.log(`[Router] Assigning Alert ${input.alertId} to Person ${input.personId} (Old Person: ${oldPersonId})`);

          // Update the current alert
          await db.updateAlert(input.alertId, { 
            personId: input.personId,
            status: "acknowledged" 
          });

          // If it was a temporary "unknown-XXXX" person, update all related records
          if (oldPersonId && oldPersonId !== input.personId) {
            const oldPerson = await db.getPersonById(oldPersonId);
            if (oldPerson && (oldPerson.name.toLowerCase().startsWith("unknown-") || oldPerson.role === "UNKNOWN")) {
               console.log(`[Router] Detected unknown person resolution. Merging ${oldPerson.name} into ${person?.name}`);
               await db.mergePersonRecords(oldPersonId, input.personId);
               await db.addAlertLog(input.alertId, "IDENTITY_RESOLVED", `Merged all historical records from ${oldPerson.name} into ${person?.name || input.personId}`);
            }
          }

          await db.addAlertLog(input.alertId, "PERSON_ASSIGNED", `Identity linked to ${person?.name || input.personId}`);
          return { success: true };
        } catch (error: any) {
          console.error("[Router] Error in assignPerson:", error);
          throw new Error(`Assignment failed: ${error.message}`);
        }
      }),

    unassignPerson: protectedProcedure
      .input(z.object({
        alertId: z.number(),
      }))
      .mutation(async ({ input }) => {
        const alert = await db.getAlertById(input.alertId);
        if (alert && alert.personId) {
          const person = await db.getPersonById(alert.personId);
          await db.updateAlert(input.alertId, { 
            personId: null,
            status: "active" 
          });
          await db.addAlertLog(input.alertId, "PERSON_UNASSIGNED", `Identity ${person?.name || alert.personId} was marked as incorrect`);
        }
        return { success: true };
      }),
  }),

  // ============ EVENTS (EVENT LOG / HISTORY) ============
  events: router({
    list: protectedProcedure
      .input(z.object({
        limit: z.number().default(100),
        offset: z.number().default(0),
      }))
      .query(async ({ input }) => {
        return db.getEvents(input.limit, input.offset);
      }),
    
    getById: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        return db.getEventById(input.id);
      }),
    
    create: adminProcedure
      .input(z.object({
        personId: z.number().optional(),
        cameraId: z.number(),
        zoneId: z.number(),
        faceSnapshotUrl: z.string().optional(),
        bestFrameSnapshotUrl: z.string().optional(),
        confidence: z.number(),
        eventType: z.enum(["recognized", "unknown", "alert"]).default("unknown"),
      }))
      .mutation(async ({ input }) => {
        return db.createEvent({
          personId: input.personId,
          cameraId: input.cameraId,
          zoneId: input.zoneId,
          faceSnapshotUrl: input.faceSnapshotUrl,
          bestFrameSnapshotUrl: input.bestFrameSnapshotUrl,
          confidence: String(input.confidence) as any,
          eventType: input.eventType,
        });
      }),
  }),

  // ============ SETTINGS (ADMIN ONLY) ============
  settings: router({
    get: adminProcedure.query(async () => {
      return db.getSettings();
    }),
    
    update: adminProcedure
      .input(z.object({
        platformName:             z.string().optional(),
        retentionDays:            z.number().optional(),
        clearOnStart:             z.boolean().optional(),
        testMode:                 z.boolean().optional(),
        notificationPreferences:  z.any().optional(),
        cvMotionClipMaxFrames:    z.number().optional(),
        cvFlipbookInterval:       z.number().optional(),
      }))
      .mutation(async ({ input }) => {
        const data: any = {};
        if (input.platformName            !== undefined) data.platformName            = input.platformName;
        if (input.retentionDays           !== undefined) data.retentionDays           = input.retentionDays;
        if (input.clearOnStart            !== undefined) data.clearOnStart            = input.clearOnStart;
        if (input.testMode                !== undefined) data.testMode                = input.testMode;
        if (input.notificationPreferences !== undefined) data.notificationPreferences = input.notificationPreferences;
        if (input.cvMotionClipMaxFrames   !== undefined) data.cvMotionClipMaxFrames   = input.cvMotionClipMaxFrames;
        if (input.cvFlipbookInterval      !== undefined) data.cvFlipbookInterval      = input.cvFlipbookInterval;
        return db.updateSettings(data);
      }),
    
    clearData: adminProcedure.mutation(async () => {
      return db.clearAlertsAndEvents();
    }),

    fullReset: adminProcedure.mutation(async () => {
      return db.fullSystemReset();
    }),

    // ── Developer: video stream management ───────────────────────────────────
    listVideos: adminProcedure.query(() => {
      try {
        return fs.readdirSync("/videos")
          .filter((f) => /\.(mp4|mkv|avi|mov|ts)$/i.test(f))
          .sort();
      } catch {
        return [] as string[];
      }
    }),

    currentStreamVideo: adminProcedure.query(() => {
      try {
        return fs.readFileSync("/app/streamer_config/current_video.txt", "utf8").trim() || null;
      } catch {
        return null;
      }
    }),

    applyStreamVideo: adminProcedure
      .input(z.object({ filename: z.string().min(1) }))
      .mutation(({ input }) => {
        const { filename } = input;
        fs.mkdirSync("/app/streamer_config", { recursive: true });
        fs.writeFileSync("/app/streamer_config/current_video.txt", filename, "utf8");
        return { success: true, streamUrl: "rtsp://mediamtx:8554/dev" };
      }),
  }),

  // ============ ACCESS RULES ============
  accessRules: router({
    getByPerson: protectedProcedure
      .input(z.object({ personId: z.number() }))
      .query(async ({ input }) => {
        return db.getAccessRulesByPerson(input.personId);
      }),
    
    getByZone: protectedProcedure
      .input(z.object({ zoneId: z.number() }))
      .query(async ({ input }) => {
        return db.getAccessRulesByZone(input.zoneId);
      }),
    
    create: adminProcedure
      .input(z.object({
        personId: z.number(),
        zoneId: z.number(),
        allowed: z.boolean().default(false),
      }))
      .mutation(async ({ input }) => {
        return db.createAccessRule(input);
      }),
    
    update: adminProcedure
      .input(z.object({
        id: z.number(),
        allowed: z.boolean(),
      }))
      .mutation(async ({ input }) => {
        return db.updateAccessRule(input.id, { allowed: input.allowed });
      }),
  }),
  
  // ============ USERS (ADMIN ONLY) ============
  users: router({
    list: adminProcedure.query(async () => {
      return db.getUsers();
    }),
    
    updateRole: adminProcedure
      .input(z.object({
        id: z.number(),
        role: z.enum(["user", "admin"]),
      }))
      .mutation(async ({ input }) => {
        return db.updateUser(input.id, { role: input.role });
      }),
  }),

  // ============ CV WORKER CONFIG (ADMIN ONLY) ============
  cvConfig: router({
    get: adminProcedure.query(async () => {
      return db.getCvWorkerConfig();
    }),

    update: adminProcedure
      .input(z.object({
        alertCooldownSeconds:       z.number().int().min(1).max(300),
        biometricMemorySeconds:     z.number().int().min(0).max(300),
        biometricDistanceThreshold: z.number().min(0.10).max(0.90),
        trackingRadiusPx:           z.number().int().min(20).max(500),
        detectionBufferSeconds:     z.number().min(0.5).max(10),
        maxPresenceSeconds:         z.number().min(2).max(60),
        frameAnalysisIntervalMs:    z.number().int().min(50).max(2000),
        minFacePixels:              z.number().int().min(30).max(300),
        faceMinHeightPx:            z.number().int().min(5).max(100),
        landmarkMinPoints:          z.number().int().min(2).max(68),
        imageDownscaleFactor:       z.number().min(0.1).max(1.0),
        upsampleTimes:              z.number().int().min(0).max(3),
        recognitionTolerance:       z.number().min(0.10).max(0.90),
      }))
      .mutation(async ({ ctx, input }) => {
        await db.upsertCvWorkerConfig({
          alertCooldownSeconds:       input.alertCooldownSeconds,
          biometricMemorySeconds:     input.biometricMemorySeconds,
          biometricDistanceThreshold: String(input.biometricDistanceThreshold) as any,
          trackingRadiusPx:           input.trackingRadiusPx,
          detectionBufferSeconds:     String(input.detectionBufferSeconds) as any,
          maxPresenceSeconds:         String(input.maxPresenceSeconds) as any,
          frameAnalysisIntervalMs:    input.frameAnalysisIntervalMs,
          minFacePixels:              input.minFacePixels,
          faceMinHeightPx:            input.faceMinHeightPx,
          landmarkMinPoints:          input.landmarkMinPoints,
          imageDownscaleFactor:       String(input.imageDownscaleFactor) as any,
          upsampleTimes:              input.upsampleTimes,
          recognitionTolerance:       String(input.recognitionTolerance) as any,
        }, ctx.user.id);
        return { success: true };
      }),

    reset: adminProcedure.mutation(async ({ ctx }) => {
      await db.resetCvWorkerConfig(ctx.user.id);
      return { success: true };
    }),
  }),

  motions: motionsRouter,

  movements: router({
    list: protectedProcedure
      .input(z.object({
        limit:         z.number().default(100),
        cameraId:      z.number().optional(),
        zoneId:        z.number().optional(),
        alertId:       z.number().optional(),
        startDate:     z.string().optional(),
        endDate:       z.string().optional(),
        detectionType: z.enum(["FACE", "BODY", "MOTION"]).optional(),
      }))
      .query(async ({ input }) => {
        return db.getMovements(input);
      }),

    getById: protectedProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        return db.getMovementById(input.id);
      }),

    getByAlertId: protectedProcedure
      .input(z.object({ alertId: z.number() }))
      .query(async ({ input }) => {
        return db.getMovementByAlertId(input.alertId);
      }),
  }),

  // ============ ACCESS GROUPS ============
  groups: router({
    list: protectedProcedure.query(async () => {
      return db.listAccessGroups();
    }),

    getById: adminProcedure
      .input(z.object({ id: z.number() }))
      .query(async ({ input }) => {
        return db.getAccessGroupById(input.id);
      }),

    create: adminProcedure
      .input(z.object({
        name:        z.string().min(1).max(100),
        description: z.string().max(255).optional(),
        color:       z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
        isDefault:   z.boolean().optional(),
      }))
      .mutation(async ({ input }) => {
        return db.createAccessGroup(input);
      }),

    update: adminProcedure
      .input(z.object({
        id:          z.number(),
        name:        z.string().min(1).max(100).optional(),
        description: z.string().max(255).optional(),
        color:       z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
        isDefault:   z.boolean().optional(),
      }))
      .mutation(async ({ input }) => {
        const { id, ...data } = input;
        return db.updateAccessGroup(id, data);
      }),

    delete: adminProcedure
      .input(z.object({ id: z.number() }))
      .mutation(async ({ input }) => {
        return db.deleteAccessGroup(input.id);
      }),

    getZones: protectedProcedure
      .input(z.object({ groupId: z.number() }))
      .query(async ({ input }) => {
        return db.getGroupZones(input.groupId);
      }),

    addZone: adminProcedure
      .input(z.object({
        groupId:    z.number(),
        zoneId:     z.number(),
        startTime:  z.string().optional(),
        endTime:    z.string().optional(),
        daysOfWeek: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        const { groupId, zoneId, ...schedule } = input;
        return db.addZoneToGroup(groupId, zoneId, schedule);
      }),

    removeZone: adminProcedure
      .input(z.object({ groupId: z.number(), zoneId: z.number() }))
      .mutation(async ({ input }) => {
        return db.removeZoneFromGroup(input.groupId, input.zoneId);
      }),

    getMembers: protectedProcedure
      .input(z.object({ groupId: z.number() }))
      .query(async ({ input }) => {
        return db.getGroupMembers(input.groupId);
      }),

    personGroups: protectedProcedure
      .input(z.object({ personId: z.number() }))
      .query(async ({ input }) => {
        return db.getPersonGroups(input.personId);
      }),

    addMember: adminProcedure
      .input(z.object({ personId: z.number(), groupId: z.number() }))
      .mutation(async ({ input }) => {
        return db.addPersonToGroup(input.personId, input.groupId);
      }),

    removeMember: adminProcedure
      .input(z.object({ personId: z.number(), groupId: z.number() }))
      .mutation(async ({ input }) => {
        return db.removePersonFromGroup(input.personId, input.groupId);
      }),

    allMemberships: protectedProcedure.query(async () => {
      return db.getAllPersonGroupMemberships();
    }),
  }),

  // ============ REPORTS ============
  reports: router({
    generate: adminProcedure
      .input(z.object({
        period:     z.enum(["daily", "weekly", "monthly"]),
        entityType: z.enum(["person", "zone"]),
        entityId:   z.number().optional(),
        startDate:  z.string(),
        endDate:    z.string(),
      }))
      .query(async ({ input }) => {
        const drizzleDb = await db.getDb();
        if (!drizzleDb) throw new Error("DB unavailable");

        const { period, entityType, entityId, startDate, endDate } = input;
        const start = new Date(startDate);
        const end   = new Date(endDate);

        const dateExpr =
          period === "daily"   ? sql`DATE(zv.entryTime)` :
          period === "weekly"  ? sql`YEARWEEK(zv.entryTime, 1)` :
                                 sql`DATE_FORMAT(zv.entryTime, '%Y-%m')`;

        const entityFilter = entityId
          ? (entityType === "person" ? sql`AND zv.personId = ${entityId}` : sql`AND zv.zoneId = ${entityId}`)
          : sql``;

        const rows = await drizzleDb.execute(sql`
          SELECT
            ${dateExpr}           AS period,
            COUNT(*)              AS totalVisits,
            SUM(zv.dwellSeconds)  AS totalDwellSeconds,
            AVG(zv.dwellSeconds)  AS avgDwellSeconds,
            COUNT(DISTINCT zv.personId) AS uniquePersons,
            zv.zoneId,
            z.name                AS zoneName,
            HOUR(zv.entryTime)    AS peakHourRaw
          FROM zone_visits zv
          LEFT JOIN zones z ON z.id = zv.zoneId
          WHERE zv.entryTime BETWEEN ${start.toISOString()} AND ${end.toISOString()}
          ${entityFilter}
          GROUP BY period, zv.zoneId, z.name, peakHourRaw
          ORDER BY period ASC, totalVisits DESC
        `);

        const rowArr = rows[0] as any[];
        const periods = [...new Set(rowArr.map((r: any) => String(r.period)))];

        const zoneBreakdown = rowArr.reduce((acc: any[], r: any) => {
          const existing = acc.find(x => x.zoneId === r.zoneId);
          if (existing) {
            existing.visitCount    += Number(r.totalVisits);
            existing.totalDwellSec += Number(r.totalDwellSeconds ?? 0);
          } else {
            acc.push({ zoneId: r.zoneId, zoneName: r.zoneName, visitCount: Number(r.totalVisits), totalDwellSec: Number(r.totalDwellSeconds ?? 0) });
          }
          return acc;
        }, []);

        const totalVisits   = rowArr.reduce((s: number, r: any) => s + Number(r.totalVisits), 0);
        const totalDwellSec = rowArr.reduce((s: number, r: any) => s + Number(r.totalDwellSeconds ?? 0), 0);
        const uniquePersons = [...new Set(rowArr.map((r: any) => r.uniquePersons))].reduce((s: number, v: any) => s + Number(v), 0);

        const hourCounts: Record<number, number> = {};
        for (const r of rowArr) {
          const h = Number(r.peakHourRaw);
          hourCounts[h] = (hourCounts[h] ?? 0) + Number(r.totalVisits);
        }
        const peakHour = Object.entries(hourCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

        const result = {
          periods,
          totalVisits,
          totalDwellSeconds:  totalDwellSec,
          avgDwellSeconds:    totalVisits > 0 ? Math.round(totalDwellSec / totalVisits) : 0,
          uniquePersons,
          zoneBreakdown,
          peakHour: peakHour !== null ? Number(peakHour) : null,
        };

        // Cache result
        await drizzleDb.execute(sql`
          INSERT INTO report_cache (reportType, entityType, entityId, periodStart, data, generatedAt)
          VALUES (${period}, ${entityType}, ${entityId ?? null}, ${start.toISOString()}, ${JSON.stringify(result)}, NOW())
        `).catch(() => {});

        return result;
      }),
  }),

  // ============ ZONE HEATMAP ============
  // Attached to zones router extension:
  zoneAnalytics: router({
    heatmap: adminProcedure
      .input(z.object({ zoneId: z.number(), period: z.enum(["daily", "weekly", "monthly"]).default("daily") }))
      .query(async ({ input }) => {
        const drizzleDb = await db.getDb();
        if (!drizzleDb) throw new Error("DB unavailable");

        const days = input.period === "daily" ? 1 : input.period === "weekly" ? 7 : 30;
        const rows = await drizzleDb.execute(sql`
          SELECT
            HOUR(entryTime)   AS hour,
            AVG(dwellSeconds) AS avgDwell,
            COUNT(*)          AS visitCount
          FROM zone_visits
          WHERE zoneId = ${input.zoneId}
            AND entryTime >= DATE_SUB(NOW(), INTERVAL ${days} DAY)
          GROUP BY HOUR(entryTime)
          ORDER BY hour ASC
        `);
        const arr = rows[0] as any[];
        const full: { hour: number; avgDwell: number; visitCount: number }[] = [];
        const byHour = new Map(arr.map((r: any) => [Number(r.hour), r]));
        for (let h = 0; h < 24; h++) {
          const r = byHour.get(h);
          full.push({ hour: h, avgDwell: r ? Math.round(Number(r.avgDwell ?? 0)) : 0, visitCount: r ? Number(r.visitCount) : 0 });
        }

        const topRows = await drizzleDb.execute(sql`
          SELECT zv.personId, p.name, COUNT(*) AS visits
          FROM zone_visits zv
          LEFT JOIN persons p ON p.id = zv.personId
          WHERE zv.zoneId = ${input.zoneId} AND zv.personId IS NOT NULL
            AND zv.entryTime >= DATE_SUB(NOW(), INTERVAL ${days} DAY)
          GROUP BY zv.personId, p.name
          ORDER BY visits DESC
          LIMIT 10
        `);
        return { hourly: full, topVisitors: (topRows[0] as any[]).map((r: any) => ({ personId: r.personId, name: r.name, visits: Number(r.visits) })) };
      }),
  }),

  // ============ PERSON TIMELINE ============
  personAnalytics: router({
    timeline: adminProcedure
      .input(z.object({ personId: z.number(), startDate: z.string(), endDate: z.string() }))
      .query(async ({ input }) => {
        const drizzleDb = await db.getDb();
        if (!drizzleDb) throw new Error("DB unavailable");

        const rows = await drizzleDb.execute(sql`
          SELECT
            zv.id, zv.zoneId, z.name AS zoneName,
            c.name AS cameraName, zv.cameraId,
            zv.entryTime, zv.exitTime,
            zv.dwellSeconds, zv.accessGranted,
            zv.globalTrackId
          FROM zone_visits zv
          LEFT JOIN zones   z ON z.id = zv.zoneId
          LEFT JOIN cameras c ON c.id = zv.cameraId
          WHERE zv.personId = ${input.personId}
            AND zv.entryTime BETWEEN ${input.startDate} AND ${input.endDate}
          ORDER BY zv.entryTime ASC
        `);
        return (rows[0] as any[]).map((r: any) => ({
          id:            r.id,
          zoneId:        r.zoneId,
          zoneName:      r.zoneName,
          cameraId:      r.cameraId,
          cameraName:    r.cameraName,
          entryTime:     r.entryTime,
          exitTime:      r.exitTime,
          dwellSeconds:  r.dwellSeconds !== null ? Number(r.dwellSeconds) : null,
          accessGranted: Boolean(r.accessGranted),
          globalTrackId: r.globalTrackId,
        }));
      }),
  }),

  // ============ REVIEW QUEUE + CONFIRM IDENTITY ============
  reviewQueue: router({
    list: adminProcedure
      .input(z.object({ limit: z.number().default(50), offset: z.number().default(0) }))
      .query(async ({ input }) => {
        const drizzleDb = await db.getDb();
        if (!drizzleDb) throw new Error("DB unavailable");

        const rows = await drizzleDb.execute(sql`
          SELECT
            a.id, a.personId, a.cameraId, a.zoneId,
            a.faceSnapshotUrl, a.bestFrameSnapshotUrl,
            a.confidence, a.threatLevel, a.timestamp,
            p.name AS personName, p.role AS personRole,
            c.name AS cameraName, z.name AS zoneName
          FROM alerts a
          LEFT JOIN persons p ON p.id = a.personId
          LEFT JOIN cameras c ON c.id = a.cameraId
          LEFT JOIN zones   z ON z.id = a.zoneId
          WHERE a.status = 'pending_review'
          ORDER BY a.timestamp DESC
          LIMIT ${input.limit} OFFSET ${input.offset}
        `);
        return (rows[0] as any[]);
      }),

    confirmIdentity: adminProcedure
      .input(z.object({
        alertId:           z.number(),
        confirmedPersonId: z.number().optional(),
        markUnknown:       z.boolean().optional(),
      }))
      .mutation(async ({ input }) => {
        const drizzleDb = await db.getDb();
        if (!drizzleDb) throw new Error("DB unavailable");

        const newStatus = 'active';
        if (input.confirmedPersonId) {
          await drizzleDb.execute(sql`
            UPDATE alerts SET status = ${newStatus}, personId = ${input.confirmedPersonId}
            WHERE id = ${input.alertId}
          `);
          // Log identity correction event
          const alertRow = await drizzleDb.execute(sql`
            SELECT cameraId, zoneId, faceSnapshotUrl, bestFrameSnapshotUrl, confidence
            FROM alerts WHERE id = ${input.alertId}
          `);
          const a = (alertRow[0] as any[])[0];
          if (a) {
            await drizzleDb.execute(sql`
              INSERT INTO events (personId, alertId, cameraId, zoneId, faceSnapshotUrl, bestFrameSnapshotUrl, confidence, eventType)
              VALUES (${input.confirmedPersonId}, ${input.alertId}, ${a.cameraId}, ${a.zoneId}, ${a.faceSnapshotUrl}, ${a.bestFrameSnapshotUrl}, ${a.confidence}, 'identity_correction')
            `);
          }
        } else {
          await drizzleDb.execute(sql`
            UPDATE alerts SET status = ${newStatus} WHERE id = ${input.alertId}
          `);
        }
        return { success: true };
      }),
  }),

  // ============ PERSONS — ADDITIONAL PROCEDURES ============
  personsExtra: router({
    addEncoding: adminProcedure
      .input(z.object({ personId: z.number(), photoBase64: z.string() }))
      .mutation(async ({ input }) => {
        const drizzleDb = await db.getDb();
        if (!drizzleDb) throw new Error("DB unavailable");

        // Save photo
        const matches = input.photoBase64.match(/^data:image\/([A-Za-z-+\/]+);base64,(.+)$/);
        if (!matches) throw new Error("Invalid base64 image");
        const ext      = matches[1] === 'jpeg' ? 'jpg' : matches[1];
        const buffer   = Buffer.from(matches[2], "base64");
        const filename = `face_angle_${crypto.randomUUID()}.${ext}`;
        const uploadDir = path.join(process.cwd(), "client/public/uploads");
        if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
        fs.writeFileSync(path.join(uploadDir, filename), buffer);
        const photoUrl = `/uploads/${filename}`;

        // Update photoUrl for person if not set; use CV worker to get encoding
        await drizzleDb.execute(sql`
          UPDATE persons SET photoUrl = COALESCE(photoUrl, ${photoUrl}) WHERE id = ${input.personId}
        `);

        // Call CV worker to encode and append
        let encodingCount = 1;
        try {
          const resp = await fetch(`${ENV.cvWorkerUrl}/api/encode-person-angle`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ personId: input.personId, photoUrl }),
          });
          if (resp.ok) {
            const data = await resp.json() as any;
            encodingCount = data.encodingCount ?? 1;
          }
        } catch (e) {
          // CV worker not reachable — encoding will be triggered on next worker run
        }

        return { photoUrl, encodingCount };
      }),

    encodingCount: adminProcedure
      .input(z.object({ personId: z.number() }))
      .query(async ({ input }) => {
        const drizzleDb = await db.getDb();
        if (!drizzleDb) return { count: 0 };
        const rows = await drizzleDb.execute(sql`
          SELECT faceEncoding, faceEncodings FROM persons WHERE id = ${input.personId}
        `);
        const r = (rows[0] as any[])[0];
        if (!r) return { count: 0 };
        let count = 0;
        // Count multi-angle encodings array
        if (r.faceEncodings) {
          try {
            const enc = typeof r.faceEncodings === 'string' ? JSON.parse(r.faceEncodings) : r.faceEncodings;
            if (Array.isArray(enc)) count = enc.length;
          } catch { /* ignore */ }
        }
        // If no multi-encodings, count the single faceEncoding
        if (count === 0 && r.faceEncoding) count = 1;
        return { count };
      }),
  }),
});

export type AppRouter = typeof appRouter;
