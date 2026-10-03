// Vercel project configuration (compiled to vercel.json by the Vercel CLI at build time).
import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  framework: "nextjs",
  crons: [
    // Runs every background job that is due (app/api/cron/tick/route.ts). Hobby allows one run a
    // day, so this is a backstop: the screen's own requests start the jobs while it is open. On Pro,
    // "* * * * *" (every minute) keeps song requests and the coin flip moving with no screen open.
    { path: "/api/cron/tick", schedule: "0 12 * * *" },
  ],
};
