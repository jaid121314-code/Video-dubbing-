import { randomUUID } from "node:crypto";

export enum ProcessStage {
  Created = "created",
  Uploading = "uploading",
  Analyzing = "analyzing",
  Cutting = "cutting",
  Matching = "matching",
  Syncing = "syncing",
  Merging = "merging",
  Rendering = "rendering",
  Completed = "completed",
  Failed = "failed",
}

export interface JobAssets {
  videoPath?: string;
  srtPath?: string;
  zipPath?: string;
}

export interface JobPreview {
  index: number;
  videoDur: number;
  audioDur: number;
  speed: number;
}

export interface Job {
  id: string;
  createdAt: number;
  workDir: string;
  stage: ProcessStage;
  progress: number;
  error?: string;
  assets: JobAssets;
  processedSegments?: number;
  totalSegments?: number;
  currentBatch?: number;
  totalBatches?: number;
  preview?: JobPreview[];
  finalPath?: string;
}

export class JobStore {
  private jobs = new Map<string, Job>();

  create(workDir: string): Job {
    const id = randomUUID();
    const job: Job = {
      id,
      createdAt: Date.now(),
      workDir,
      stage: ProcessStage.Created,
      progress: 0,
      assets: {},
    };
    this.jobs.set(id, job);
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  update(id: string, patch: Partial<Job>): void {
    const j = this.jobs.get(id);
    if (!j) return;
    Object.assign(j, patch);
  }

  fail(id: string, error: string): void {
    this.update(id, { stage: ProcessStage.Failed, error });
  }
}
