import amqp, { Channel } from "amqplib";
import { randomUUID } from "node:crypto";
import { createClient } from "redis";

type MergeJob<T> = { id: string; payload: T; detail: unknown };
export type MergeJobStatus = {
  id: string;
  type: string;
  status: "queued" | "running" | "completed" | "failed";
  progress: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  elapsedMs?: number;
  runTimeMs?: number;
  error?: string;
  detail: unknown;
  outputs?: { path: string; runTimeMs: number }[];
};

export class MergeQueue<TJob, TResult extends { outputs: { path: string; runTimeMs: number }[]; runTimeMs: number }> {
  private readonly queueName = process.env.MERGE_QUEUE_NAME || "video-merge";
  private readonly connectionUrl = process.env.RABBITMQ_URL || "amqp://rabbitmq:5672";
  private readonly redis = createClient({ url: process.env.REDIS_URL || "redis://redis:6379" });
  private channel?: Channel;
  private readonly ready: Promise<void>;

  constructor(private readonly processJob?: (job: TJob, onProgress: (progress: number) => void) => Promise<TResult>) {
    this.redis.on("error", (error) => console.error("Redis connection error", error));
    this.ready = Promise.all([this.startRabbitMq(), this.connectRedis()]).then(() => undefined);
  }

  async enqueue(payload: TJob, detail: unknown, onProgress?: (progress: number) => void, onQueued?: (position: number) => void): Promise<TResult> {
    await this.ready;
    if (!this.channel) throw new Error("Merge queue is unavailable");

    const queueState = await this.channel.checkQueue(this.queueName);
    onQueued?.(queueState.messageCount + 1);
    const id = randomUUID();
    await this.saveStatus(this.createStatus(id, payload, detail));
    const job: MergeJob<TJob> = { id, payload, detail };
    if (!this.channel.sendToQueue(this.queueName, Buffer.from(JSON.stringify(job)), { persistent: true })) {
      throw new Error("Merge queue is unavailable");
    }
    return this.waitForResult(id, onProgress);
  }

  async listJobs(): Promise<MergeJobStatus[]> {
    await this.ready;
    const ids = await this.redis.zRange("merge:jobs", 0, -1, { REV: true });
    const records = await Promise.all(ids.map((id) => this.redis.get(`merge:job:${id}`)));
    return records.filter((record): record is string => record !== null).map((record) => JSON.parse(record));
  }

  async deleteJob(id: string): Promise<boolean> {
    await this.ready;
    const deleted = await this.redis.del(`merge:job:${id}`);
    await this.redis.zRem("merge:jobs", id);
    return deleted > 0;
  }

  private async startRabbitMq(): Promise<void> {
    const connection = await this.connectRabbitMq();
    const channel = await connection.createChannel();
    this.channel = channel;
    await channel.assertQueue(this.queueName, { durable: true });
    connection.on("error", (error) => console.error("RabbitMQ connection error", error));
    connection.on("close", () => console.error("RabbitMQ connection closed"));
    if (this.processJob) {
      await channel.prefetch(1);
      await channel.consume(this.queueName, (message) => {
        if (message) void this.handleMessage(channel, message);
      });
    }
  }

  private async connectRabbitMq(): Promise<Awaited<ReturnType<typeof amqp.connect>>> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await amqp.connect(this.connectionUrl);
      } catch (error) {
        console.error(`RabbitMQ connection attempt ${attempt} failed`, error);
        await this.delay(Math.min(attempt * 2000, 10000));
      }
    }
  }

  private async connectRedis(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.redis.connect();
        return;
      } catch (error) {
        console.error(`Redis connection attempt ${attempt} failed`, error);
        if (this.redis.isOpen) await this.redis.disconnect();
        await this.delay(Math.min(attempt * 2000, 10000));
      }
    }
  }

  private delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  private elapsedMs(startedAt: string): number {
    return Math.max(0, Date.now() - Date.parse(startedAt));
  }

  private async handleMessage(channel: Channel, message: amqp.ConsumeMessage): Promise<void> {
    if (!this.processJob) {
      channel.nack(message, false, true);
      return;
    }
    const job = JSON.parse(message.content.toString()) as MergeJob<TJob>;
    const status = this.createStatus(job.id, job.payload, job.detail);
    const startedAt = new Date().toISOString();
    await this.saveStatus({ ...status, status: "running", startedAt, updatedAt: startedAt });
    try {
      const result = await this.processJob(job.payload, (progress) => {
        void this.updateStatus(job.id, { progress, elapsedMs: this.elapsedMs(startedAt) });
      });
      await this.updateStatus(job.id, { status: "completed", progress: 100, elapsedMs: this.elapsedMs(startedAt), runTimeMs: result.runTimeMs, outputs: result.outputs });
    } catch (error) {
      await this.updateStatus(job.id, { status: "failed", elapsedMs: this.elapsedMs(startedAt), error: error instanceof Error ? error.message : "Merge failed" });
    } finally {
      channel.ack(message);
    }
  }

  private async waitForResult(id: string, onProgress?: (progress: number) => void): Promise<TResult> {
    for (;;) {
      const record = await this.redis.get(`merge:job:${id}`);
      if (!record) throw new Error("Merge job status was lost");
      const status = JSON.parse(record) as MergeJobStatus;
      onProgress?.(status.progress);
      if (status.status === "completed" && status.outputs && status.runTimeMs !== undefined) {
        return { outputs: status.outputs, runTimeMs: status.runTimeMs } as TResult;
      }
      if (status.status === "failed") throw new Error(status.error || "Merge failed");
      await this.delay(500);
    }
  }

  private createStatus(id: string, payload: TJob, detail: unknown): MergeJobStatus {
    const now = new Date().toISOString();
    return { id, type: this.getJobType(payload), status: "queued", progress: 0, createdAt: now, updatedAt: now, detail };
  }

  private async saveStatus(status: MergeJobStatus): Promise<void> {
    await this.redis.multi()
      .set(`merge:job:${status.id}`, JSON.stringify(status))
      .zAdd("merge:jobs", { score: Date.parse(status.createdAt), value: status.id })
      .exec();
  }

  private async updateStatus(id: string, update: Partial<MergeJobStatus>): Promise<void> {
    const record = await this.redis.get(`merge:job:${id}`);
    if (!record) return;
    await this.saveStatus({ ...JSON.parse(record) as MergeJobStatus, ...update, updatedAt: new Date().toISOString() });
  }

  private getJobType(payload: TJob): string {
    return typeof payload === "object" && payload !== null && "type" in payload
      ? String((payload as { type: unknown }).type)
      : "merge";
  }
}

export default MergeQueue;
