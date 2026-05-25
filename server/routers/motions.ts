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
      tab:      z.enum(['all', 'face', 'body']).default('all'),
    }))
    .query(async ({ input }) => {
      const db = await getDb()
      if (!db) throw new Error('DB unavailable')

      const conditions = []
      if (input.cameraId) conditions.push(eq(motions.cameraId, input.cameraId))
      if (input.zoneId)   conditions.push(eq(motions.zoneId,   input.zoneId))
      if (input.since)    conditions.push(gte(motions.detectedAt, new Date(input.since)))
      if (input.tab === 'face') conditions.push(sql`${motions.personsDetected} > 0`)
      if (input.tab === 'body') conditions.push(sql`${motions.personsDetected} > 0`)

      const rows = await db
        .select({
          id:               motions.id,
          cameraId:         motions.cameraId,
          cameraName:       cameras.name,
          zoneId:           motions.zoneId,
          zoneName:         zones.name,
          frameSnapshotUrl: motions.frameSnapshotUrl,
          frame2Url:        motions.frame2Url,
          frame3Url:        motions.frame3Url,
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

      const since = new Date(Date.now() - input.hours * 3600_000)

      const [result] = await db.execute(sql`
        SELECT
          COUNT(*)                                               AS total,
          SUM(CASE WHEN personsDetected > 1  THEN 1 ELSE 0 END) AS multiPerson,
          SUM(CASE WHEN personsDetected > 0  THEN 1 ELSE 0 END) AS withPerson,
          COUNT(DISTINCT cameraId)                               AS activeCameras
        FROM motions
        WHERE detectedAt >= ${since}
      `) as any[]

      const [alertStats] = await db.execute(sql`
        SELECT
          SUM(CASE WHEN detectionType = 'face'      THEN 1 ELSE 0 END) AS withFace,
          SUM(CASE WHEN detectionType = 'body_only' THEN 1 ELSE 0 END) AS withBody,
          COUNT(CASE WHEN status = 'active'          THEN 1 END)        AS withAlert
        FROM alerts
        WHERE createdAt >= ${since}
      `) as any[]

      return {
        total:         Number(result?.total         ?? 0),
        multiPerson:   Number(result?.multiPerson   ?? 0),
        withPerson:    Number(result?.withPerson     ?? 0),
        activeCameras: Number(result?.activeCameras ?? 0),
        withFace:      Number(alertStats?.withFace  ?? 0),
        withBody:      Number(alertStats?.withBody  ?? 0),
        withAlert:     Number(alertStats?.withAlert ?? 0),
      }
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
