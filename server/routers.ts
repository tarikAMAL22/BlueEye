import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router, protectedProcedure, adminProcedure } from "./_core/trpc";
import { z } from "zod";
import * as db from "./db";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";

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
          fetch("http://cv-worker:5000/api/encode-person", {
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
          fetch("http://cv-worker:5000/api/encode-person", {
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
        const response = await fetch("http://cv-worker:5000/api/encode-person", {
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
          const response = await fetch("http://cv-worker:5000/api/count-faces", {
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
          const response = await fetch("http://cv-worker:5000/api/re-match", {
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
      }))
      .mutation(async ({ input }) => {
        const data: any = {};
        if (input.platformName            !== undefined) data.platformName            = input.platformName;
        if (input.retentionDays           !== undefined) data.retentionDays           = input.retentionDays;
        if (input.clearOnStart            !== undefined) data.clearOnStart            = input.clearOnStart;
        if (input.testMode                !== undefined) data.testMode                = input.testMode;
        if (input.notificationPreferences !== undefined) data.notificationPreferences = input.notificationPreferences;
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

  movements: router({
    list: protectedProcedure
      .input(z.object({
        limit:     z.number().default(100),
        cameraId:  z.number().optional(),
        zoneId:    z.number().optional(),
        alertId:   z.number().optional(),
        startDate: z.string().optional(),
        endDate:   z.string().optional(),
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
});

export type AppRouter = typeof appRouter;
