import { randomUUID } from "node:crypto";

export enum ProcessStage {
  Created = "created",
  Uploading = "uploading",
  Analyzing = "analyzing",
  Validating = "validating",
  Processing = "processing",
  Retrying = "retrying",
  FailedSegment = "failed_segment",
  Merging = "merging",
  FinalEncoding = "final_encoding",
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

export interface SegmentReport {
  segmentNumber: number;
  srtStart: number;
  srtEnd: number;
  correctedStart: number;
  correctedEnd: number;
  videoDuration: number;
  audioDuration: number;
  speedFactor: number;
  outputDuration: number;
}

export interface JobValidation {
  videoDuration: number;
  srtSegments: number;
  audioFiles: number;
  countMatch: boolean;
  timestampWarnings: string[];
  invalidSegments: { index: number; reason: string }[];
  passed: boolean;
}

export interface Job {
  id: string;
  createdAt: number;
  workDir: string;
  stage: ProcessStage;
  progress: number;
  error?: string;
  errorSegment?: number;
  assets: JobAssets;
  processedSegments?: number;
  totalSegments?: number;
  retryingSegment?: number;
  preview?: JobPreview[];
  validation?: JobValidation;
  finalPath?: string;
  completedAt?: number;
  segmentReport?: SegmentReport[];
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

  all(): Job[] {
    return [...this.jobs.values()];
  }

  delete(id: string): void {
    this.jobs.delete(id);
  }

  update(id: string, patch: Partial<Job>): void {
    const j = this.jobs.get(id);
    if (!j) return;
    Object.assign(j, patch);
  }

  fail(id: string, error: string, errorSegment?: number): void {
    this.update(id, { stage: ProcessStage.Failed, error, errorSegment });
  }
}
