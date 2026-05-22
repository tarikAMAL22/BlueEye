import { z } from 'zod'
import { router, protectedProcedure } from '../_core/trpc'
import { getDb } from '../db'
import { sql, desc, eq, and, gte } from 'drizzle-orm'
import { motions, cameras, zones } from '../../drizzle/schema'

export const motionsRouter = router({

  list: protectedProcedure
    .input(z.object({
      limit:    z.number().min(1).max(500).default(100),
      offset:   z.number().min(0).default(0),
      cameraId: z.number().optional(),
      zoneId:   z.number().optional(),
      since:    z.string().datetime().optional(),
    }))
    .query(async ({ input }) => {
      const db = await getDb()
      if (!db) throw new Error('DB unavailable')

      const conditions = []
      if (input.cameraId) conditions.push(eq(motions.cameraId, input.cameraId))
      if (input.zoneId)   conditions.push(eq(motions.zoneId,   input.zoneId))
      if (input.since)    conditions.push(gte(motions.detectedAt, new Date(input.since)))

      const rows = await db
        .select({
          id:               motions.id,
          cameraId:         motions.cameraId,
          cameraName:       cameras.name,
          zoneId:           motions.zoneId,
          zoneName:         zones.name,
          frameSnapshotUrl: motions.frameSnapshotUrl,
          motionArea:       motions.motionArea,
          personsDetected:  motions.personsDetected,
          detectedAt:       motions.detectedAt,
        })
        .from(motions)
        .leftJoin(cameras, eq(motions.cameraId, cameras.id))
        .leftJoin(zones,   eq(motions.zoneId,   zones.id))
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(motions.detectedAt))
        .limit(input.limit)
        .offset(input.offset)

      const [{ total }] = await db
        .select({ total: sql<number>`COUNT(*)` })
        .from(motions)
        .where(conditions.length ? and(...conditions) : undefined)

      return { rows, total: Number(total) }
    }),

  stats: protectedProcedure
    .input(z.object({
      hours: z.number().min(1).max(168).default(24),
    }))
    .query(async ({ input }) => {
      const db = await getDb()
      if (!db) throw new Error('DB unavailable')

      const since = new Date(Date.now() - input.hours * 3600 * 1000)
      const rows = await db.execute(sql`
        SELECT
          c.name AS cameraName,
          DATE_FORMAT(m.detectedAt, '%Y-%m-%d %H:00:00') AS hour,
          COUNT(*) AS motionCount,
          SUM(m.personsDetected) AS personsTotal,
          AVG(m.motionArea) AS avgMotionArea
        FROM motions m
        LEFT JOIN cameras c ON m.cameraId = c.id
        WHERE m.detectedAt >= ${since}
        GROUP BY c.name, DATE_FORMAT(m.detectedAt, '%Y-%m-%d %H:00:00')
        ORDER BY hour DESC, motionCount DESC
      `)
      return rows
    }),

  cleanup: protectedProcedure
    .input(z.object({
      olderThanDays: z.number().min(1).max(365).default(7),
    }))
    .mutation(async ({ input }) => {
      const db = await getDb()
      if (!db) throw new Error('DB unavailable')

      const cutoff = new Date(Date.now() - input.olderThanDays * 86400 * 1000)
      const result = await db.delete(motions).where(sql`detectedAt < ${cutoff}`)
      return { deleted: (result as any).rowsAffected ?? 0 }
    }),
})
