import { z } from 'zod';
import { router, protectedProcedure } from '../_core/trpc';

const STREAM_SERVER = process.env.STREAM_SERVER_URL || 'http://localhost:4253';
// HLS segments are served via the /stream-hls reverse-proxy on the app server.
// Return a relative path so the browser resolves it against its own origin —
// avoids localhost/hardcoded-IP mismatches across environments.

export const streamRouter = router({
  start: protectedProcedure
    .input(z.object({ cameraId: z.number() }))
    .mutation(async ({ input }) => {
      const res = await fetch(`${STREAM_SERVER}/stream/start/${input.cameraId}`, { method: 'POST' });
      if (!res.ok) throw new Error(`Stream server: ${res.status}`);
      const data = await res.json() as { hlsUrl: string; status: string };
      return { ...data, hlsUrl: `/stream-hls${data.hlsUrl}` };
    }),

  status: protectedProcedure
    .input(z.object({ cameraId: z.number() }))
    .query(async ({ input }) => {
      try {
        const res = await fetch(`${STREAM_SERVER}/stream/status/${input.cameraId}`);
        const data = await res.json() as { active: boolean; hlsUrl: string | null };
        if (data.hlsUrl) data.hlsUrl = `/stream-hls${data.hlsUrl}`;
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
