// Every background job (lib/jobs.ts), for the cron route: /api/cron/tick runs the ones that are due.

import { coinFlipJob } from "./coin-flip";
import { feedJob } from "./feed";
import { runJob, type JobOutcome, type JobSpec } from "./jobs";
import { quotesJob } from "./quotes";
import { songsJob, songsPolling } from "./songs";

function jobs(): JobSpec[] {
  return [songsPolling() ? songsJob : null, coinFlipJob, quotesJob, feedJob].filter((job): job is JobSpec => job !== null);
}

/** Runs every due job, side by side, and reports what each did. Never throws. */
export async function runDueJobs(): Promise<Record<string, JobOutcome>> {
  const list = jobs();
  const outcomes = await Promise.all(list.map((job) => runJob(job)));
  return Object.fromEntries(list.map((job, index) => [job.name, outcomes[index]]));
}
