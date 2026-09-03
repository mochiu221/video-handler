import { createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Client } from "minio";

export class FileStorageService {
  private readonly client: Client;
  private readonly bucket = process.env.MINIO_BUCKET || "video-handler";
  private bucketReady?: Promise<void>;

  constructor() {
    const endpoint = new URL(process.env.MINIO_URL || "http://minio:9000");
    this.client = new Client({
      endPoint: endpoint.hostname,
      port: Number(endpoint.port) || (endpoint.protocol === "https:" ? 443 : 80),
      useSSL: endpoint.protocol === "https:",
      accessKey: process.env.MINIO_ACCESS_KEY || "video-handler",
      secretKey: process.env.MINIO_SECRET_KEY || "video-handler-dev",
    });
  }

  async ensureBucket(): Promise<void> {
    this.bucketReady ??= (async () => {
      if (!(await this.client.bucketExists(this.bucket))) await this.client.makeBucket(this.bucket);
    })();
    return this.bucketReady;
  }

  async downloadToFile(objectPath: string, directory: string): Promise<string> {
    await this.ensureBucket();
    await mkdir(directory, { recursive: true });
    const destination = path.join(directory, `${randomUUID()}-${path.posix.basename(objectPath)}`);
    await pipeline(await this.client.getObject(this.bucket, this.objectKey(objectPath)), createWriteStream(destination));
    return destination;
  }

  async uploadFile(objectPath: string, filePath: string, contentType = "video/mp4"): Promise<void> {
    await this.ensureBucket();
    await this.client.fPutObject(this.bucket, this.objectKey(objectPath), filePath, { "Content-Type": contentType });
  }

  async cleanup(directory: string): Promise<void> {
    await rm(directory, { recursive: true, force: true });
  }

  private objectKey(objectPath: string): string {
    return objectPath.replaceAll("\\", "/").replace(/^\/+/, "");
  }
}

export default FileStorageService;