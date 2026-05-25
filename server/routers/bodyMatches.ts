import { z } from 'zod'
import { router, protectedProcedure } from '../_core/trpc'
import { getDb } from '../db'
import { sql, eq, and, gte, ne, isNotNull } from 'drizzle-orm'
import { alerts, cameras, zones, persons } from '../../drizzle/schema'

const DEFAULT_WINDOW_MINUTES = 5

function cosineSim(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    dot   += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom > 0 ? dot / denom : 0
}

export const bodyMatchesRouter = router({

  getSuggestions: protectedProcedure
    .input(z.object({
      alertId:       z.number(),
      windowMinutes: z.number().min(1).max(60).default(DEFAULT_WINDOW_MINUTES),
      limit:         z.number().min(1).max(20).default(10),
    }))
    .query(async ({ input }) => {
      const db = await getDb()
      if (!db) throw new Error('DB unavailable')

      const [targetAlert] = await db
        .select({
          id:                  alerts.id,
          appearanceEmbedding: alerts.appearanceEmbedding,
          cameraId:            alerts.cameraId,
          detectionType:       alerts.detectionType,
          createdAt:           alerts.createdAt,
        })
        .from(alerts)
        .where(eq(alerts.id, input.alertId))
        .limit(1)

      if (!targetAlert?.appearanceEmbedding) {
        return { suggestions: [], message: 'No appearance embedding for this alert', windowMinutes: input.windowMinutes, totalCandidates: 0 }
      }

      let targetEmb: number[]
      try {
        targetEmb = JSON.parse(targetAlert.appearanceEmbedding)
      } catch {
        return { suggestions: [], message: 'Invalid embedding data', windowMinutes: input.windowMinutes, totalCandidates: 0 }
      }

      const since = new Date(Date.now() - input.windowMinutes * 60_000)

      const candidates = await db
        .select({
          alertId:              alerts.id,
          personId:             alerts.personId,
          cameraId:             alerts.cameraId,
          cameraName:           cameras.name,
          zoneName:             zones.name,
          faceSnapshotUrl:      alerts.faceSnapshotUrl,
          bestFrameSnapshotUrl: alerts.bestFrameSnapshotUrl,
          confidence:           alerts.confidence,
          detectionType:        alerts.detectionType,
          appearanceEmbedding:  alerts.appearanceEmbedding,
          createdAt:            alerts.createdAt,
          personName:           persons.name,
          personRole:           persons.role,
          personPhoto:          persons.photoUrl,
        })
        .from(alerts)
        .leftJoin(cameras, eq(alerts.cameraId, cameras.id))
        .leftJoin(zones,   eq(alerts.zoneId,   zones.id))
        .leftJoin(persons, eq(alerts.personId, persons.id))
        .where(and(
          ne(alerts.id, input.alertId),
          gte(alerts.createdAt, since),
          isNotNull(alerts.appearanceEmbedding),
        ))
        .orderBy(sql`${alerts.createdAt} DESC`)
        .limit(100)

      const scored = candidates
        .map(c => {
          if (!c.appearanceEmbedding) return null
          try {
            const emb = JSON.parse(c.appearanceEmbedding) as number[]
            const sim = cosineSim(targetEmb, emb)
            return { ...c, similarityScore: sim }
          } catch {
            return null
          }
        })
        .filter((c): c is NonNullable<typeof c> => c !== null && c.similarityScore > 0.75)
        .sort((a, b) => b.similarityScore - a.similarityScore)
        .slice(0, input.limit)

      return {
        suggestions: scored.map(s => ({
          alertId:              s.alertId,
          personId:             s.personId,
          personName:           s.personName,
          personRole:           s.personRole,
          personPhoto:          s.personPhoto,
          cameraName:           s.cameraName,
          zoneName:             s.zoneName,
          faceSnapshotUrl:      s.faceSnapshotUrl ?? s.bestFrameSnapshotUrl,
          detectionType:        s.detectionType,
          similarityScore:      Math.round(s.similarityScore * 100),
          distanceSeconds:      Math.round(
            (new Date(targetAlert.createdAt!).getTime() -
             new Date(s.createdAt!).getTime()) / 1000
          ),
          createdAt:            s.createdAt,
        })),
        windowMinutes:    input.windowMinutes,
        totalCandidates:  candidates.length,
      }
    }),

  assignPerson: protectedProcedure
    .input(z.object({
      alertId:  z.number(),
      personId: z.number(),
    }))
    .mutation(async ({ input, ctx }) => {
      const db = await getDb()
      if (!db) throw new Error('DB unavailable')

      await db.update(alerts)
        .set({ personId: input.personId, status: 'acknowledged' })
        .where(eq(alerts.id, input.alertId))

      try {
        await db.execute(sql`
          INSERT IGNORE INTO body_assignments
            (alertId, personId, assignedBy, assignedAt)
          VALUES (${input.alertId}, ${input.personId},
                  ${(ctx as any).user?.id ?? null}, NOW())
        `)
      } catch { /* table may not exist */ }

      return { success: true }
    }),

  dismissSuggestions: protectedProcedure
    .input(z.object({ alertId: z.number() }))
    .mutation(async ({ input }) => {
      const db = await getDb()
      if (!db) throw new Error('DB unavailable')

      await db.update(alerts)
        .set({ status: 'acknowledged' })
        .where(eq(alerts.id, input.alertId))

      return { success: true }
    }),
})
