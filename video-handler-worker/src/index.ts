import amqp, { ConsumeMessage } from "amqplib";
import { createClient } from "redis";
import FfmpegService from "./services/ffmpeg.service.js";
import { MergeVideoOutput } from "./models/request-response/MergeVideoOutput.js";
import { MergeVideosBatchResult } from "./models/request-response/MergeVideosBatchResult.js";
import { VideoImageOverlay } from "./models/VideoImageOverlay.js";

const queueName = process.env.MERGE_QUEUE_NAME || "video-merge";
const rabbitmqUrl = process.env.RABBITMQ_URL || "amqp://rabbitmq:5672";
const redis = createClient({ url: process.env.REDIS_URL || "redis://redis:6379" });
const ffmpeg = new FfmpegService();

type MainImage = { imagePath: string; startTime: number; duration?: number };
type MergeJob =
  | { type: "raw"; videoPaths: string[]; outputs: MergeVideoOutput[]; images: VideoImageOverlay[] }
  | { type: "composition"; openingVideoPaths: string[]; openingImagePaths: string[]; mainVideoPath: string; mainImages: MainImage[]; endingVideoPaths: string[]; endingImagePaths: string[]; outputs: MergeVideoOutput[] };
type QueueMessage = { id: string; payload: MergeJob };
type JobStatus = { status: string; progress: number; payload?: MergeJob; startedAt?: string; elapsedMs?: number; runTimeMs?: number; outputs?: MergeVideosBatchResult["outputs"]; error?: string };

redis.on("error", (error) => console.error("Redis connection error", error));

async function main(): Promise<void> {
  await connectRedis();
  const connection = await connectRabbitMq();
  const channel = await connection.createChannel();
  await channel.assertQueue(queueName, { durable: true });
  await recoverMissingJobs(channel); // 重啟時恢復未完成的任務
  await channel.prefetch(1);
  connection.on("error", (error) => console.error("RabbitMQ connection error", error));
  connection.on("close", () => console.error("RabbitMQ connection closed"));
  await channel.consume(queueName, (message) => {
    if (message) void handleMessage(channel, message);
  });
  console.log(`Video handler worker listening on ${queueName}`);
}

async function recoverMissingJobs(channel: amqp.Channel): Promise<void> {
  const lock = await redis.set("merge:recovery-lock", String(process.pid), { NX: true, EX: 60 });
  if (lock !== "OK") return;

  try {
    const queuedIds = new Set<string>();
    const queuedMessages: QueueMessage[] = [];
    let message = await channel.get(queueName, { noAck: false });
    while (message) {
      const queuedJob = JSON.parse(message.content.toString()) as QueueMessage;
      queuedIds.add(queuedJob.id);
      queuedMessages.push(queuedJob);
      await channel.ack(message);
      message = await channel.get(queueName, { noAck: false });
    }

    for (const queuedJob of queuedMessages) {
      channel.sendToQueue(queueName, Buffer.from(JSON.stringify(queuedJob)), { persistent: true });
    }

    const ids = await redis.zRange("merge:jobs", 0, -1);
    for (const id of ids) {
      const record = await redis.get(`merge:job:${id}`);
      if (!record) continue;
      const status = JSON.parse(record) as JobStatus;
      if ((status.status !== "queued" && status.status !== "running") || !status.payload || queuedIds.has(id)) continue;

      await redis.set(`merge:job:${id}`, JSON.stringify({ ...status, status: "queued", progress: 0, updatedAt: new Date().toISOString() }));
      const recoveredJob: QueueMessage = { id, payload: status.payload };
      if (!channel.sendToQueue(queueName, Buffer.from(JSON.stringify(recoveredJob)), { persistent: true })) {
        throw new Error("Could not recover merge job");
      }
      console.log(`Recovered merge job ${id}`);
    }
  } finally {
    await redis.del("merge:recovery-lock");
  }
}

async function handleMessage(channel: amqp.Channel, message: ConsumeMessage): Promise<void> {
  const job = JSON.parse(message.content.toString()) as QueueMessage;
  const startedAt = new Date().toISOString();
  await updateStatus(job.id, { status: "running", progress: 0, startedAt });
  try {
    const result = await processJob(job.payload, (progress) => {
      void updateStatus(job.id, { progress, elapsedMs: elapsedMs(startedAt) });
    });
    await updateStatus(job.id, { status: "completed", progress: 100, elapsedMs: elapsedMs(startedAt), runTimeMs: result.runTimeMs, outputs: result.outputs });
  } catch (error) {
    await updateStatus(job.id, { status: "failed", elapsedMs: elapsedMs(startedAt), error: error instanceof Error ? error.message : "Merge failed" });
  } finally {
    channel.ack(message);
  }
}

async function processJob(job: MergeJob, onProgress: (progress: number) => void): Promise<MergeVideosBatchResult> {
  if (job.type === "raw") return ffmpeg.mergeVideosToOutputs(job.videoPaths, job.outputs, job.images, onProgress);
  return ffmpeg.mergeVideoComposition(job.openingVideoPaths, job.openingImagePaths, job.mainVideoPath, job.mainImages, job.endingVideoPaths, job.endingImagePaths, job.outputs, onProgress);
}

async function updateStatus(id: string, update: Partial<JobStatus>): Promise<void> {
  const key = `merge:job:${id}`;
  const record = await redis.get(key);
  if (!record) return;
  await redis.set(key, JSON.stringify({ ...JSON.parse(record) as object, ...update, updatedAt: new Date().toISOString() }));
}

function elapsedMs(startedAt: string): number {
  return Math.max(0, Date.now() - Date.parse(startedAt));
}

async function connectRedis(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await redis.connect();
      return;
    } catch (error) {
      console.error(`Redis connection attempt ${attempt} failed`, error);
      if (redis.isOpen) await redis.disconnect();
      await delay(Math.min(attempt * 2000, 10000));
    }
  }
}

async function connectRabbitMq(): Promise<Awaited<ReturnType<typeof amqp.connect>>> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await amqp.connect(rabbitmqUrl);
    } catch (error) {
      console.error(`RabbitMQ connection attempt ${attempt} failed`, error);
      await delay(Math.min(attempt * 2000, 10000));
    }
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

void main().catch((error) => {
  console.error("Worker startup failed", error);
  process.exitCode = 1;
});
