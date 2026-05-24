import { z } from 'zod';
import { router, protectedProcedure } from '../_core/trpc';

const STREAM_SERVER = process.env.STREAM_SERVER_URL || 'http://localhost:4253';
// PUBLIC_URL is the base URL the browser uses to fetch HLS segments.
// It should point to the /stream-hls proxy on the main app.
const PUBLIC_URL    = process.env.PUBLIC_URL        || 'http://localhost:8080/stream-hls';

export const streamRouter = router({
  start: protectedProcedure
    .input(z.object({ cameraId: z.number() }))
    .mutation(async ({ input }) => {
      const res = await fetch(`${STREAM_SERVER}/stream/start/${input.cameraId}`, { method: 'POST' });
      if (!res.ok) throw new Error(`Stream server: ${res.status}`);
      const data = await res.json() as { hlsUrl: string; status: string };
      return { ...data, hlsUrl: `${PUBLIC_URL}${data.hlsUrl}` };
    }),

  status: protectedProcedure
    .input(z.object({ cameraId: z.number() }))
    .query(async ({ input }) => {
      try {
        const res = await fetch(`${STREAM_SERVER}/stream/status/${input.cameraId}`);
        const data = await res.json() as { active: boolean; hlsUrl: string | null };
        if (data.hlsUrl) data.hlsUrl = `${PUBLIC_URL}${data.hlsUrl}`;
        return data;
      } catch {
        return { active: false, hlsUrl: null };
      }
    }),

  stop: protectedProcedure
    .input(z.object({ cameraId: z.number() }))
    .mutation(async ({ input }) => {
      await fetch(`${STREAM_SERVER}/stream/stop/${input.cameraId}`, { method: 'DELETE' });
      return { stopped: true };
    }),
});
