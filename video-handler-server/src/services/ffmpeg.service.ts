import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { MergeVideosOptions } from "../models/MergeVideosOptions";
import { CONFIG } from "../config";
import { MergeVideosResult } from "../models/request-response/MergeVideosResult";

const execFileAsync = promisify(execFile);

export class FfmpegService {
  private readonly ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
  private readonly uploadDirectory = path.resolve(process.env.UPLOAD_DIR || "uploads");
  private readonly mergedOutputDirectory = path.join(this.uploadDirectory, CONFIG.upload.mergedVideosFolder);

  async mergeVideos(
    videoPaths: string[],
    outputPath: string | undefined,
    options: MergeVideosOptions,
    onProgress?: (progress: number) => void,
  ): Promise<MergeVideosResult> {
    if (videoPaths.length < 2) {
      throw new Error("At least two video paths are required");
    }

    this.validateOptions(options);
    await mkdir(this.mergedOutputDirectory, { recursive: true });

    const destination = outputPath
      ? this.resolveUploadPath(outputPath)
      : path.join(this.mergedOutputDirectory, `${randomUUID()}.mp4`);
    await mkdir(path.dirname(destination), { recursive: true });
    const resolvedVideoPaths = videoPaths.map((videoPath) => this.resolveUploadPath(videoPath));
    const totalDurationMs = await this.getTotalDurationMs(resolvedVideoPaths);
    const mergeArguments = ["-y"];
    const filterParts: string[] = [];
    const concatInputs: string[] = [];

    for (const [index, videoPath] of resolvedVideoPaths.entries()) {
      mergeArguments.push("-i", videoPath);
      filterParts.push(
        `[${index}:v]scale=${options.width}:${options.height}:force_original_aspect_ratio=decrease,pad=${options.width}:${options.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,setpts=PTS-STARTPTS[video${index}]`,
        `[${index}:a]asetpts=PTS-STARTPTS[audio${index}]`,
      );
      concatInputs.push(`[video${index}]`, `[audio${index}]`);
    }

    filterParts.push(`${concatInputs.join("")}concat=n=${videoPaths.length}:v=1:a=1[mergedVideo][audio]`);
    let currentVideo = "mergedVideo";

    for (const [index, image] of (options.images || []).entries()) {
      const inputIndex = videoPaths.length + index;
      const outputLabel = `overlayVideo${index}`;
      const endTime = image.startTime + image.duration;

      mergeArguments.push("-loop", "1", "-framerate", "25", "-t", String(endTime), "-i", this.resolveUploadPath(image.imagePath));
      filterParts.push(
        `[${inputIndex}:v]scale=${options.width}:${options.height},setsar=1[image${index}]`,
        `[${currentVideo}][image${index}]overlay=0:0:enable='between(t,${image.startTime},${endTime})':eof_action=pass:repeatlast=0[${outputLabel}]`,
      );
      currentVideo = outputLabel;
    }

    mergeArguments.push(
      "-progress",
      "pipe:1",
      "-nostats",
      "-filter_complex",
      filterParts.join(";"),
      "-map",
      `[${currentVideo}]`,
      "-map",
      "[audio]",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-c:a",
      "aac",
      destination,
    );
    console.log("Executing ffmpeg command:", this.ffmpegPath, mergeArguments.join(" "));
    const startTime = performance.now();
    await this.runFfmpeg(mergeArguments, totalDurationMs, onProgress);
    const runTimeMs = Math.round(performance.now() - startTime);

    return { path: destination, runTimeMs };
  }

  private async getTotalDurationMs(videoPaths: string[]): Promise<number> {
    const durations = await Promise.all(videoPaths.map(async (videoPath) => {
      const { stdout } = await execFileAsync(process.env.FFPROBE_PATH || "ffprobe", [
        "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", videoPath,
      ]);
      const durationMs = Number.parseFloat(stdout) * 1000;

      if (!Number.isFinite(durationMs) || durationMs <= 0) {
        throw new Error(`Unable to determine duration for ${videoPath}`);
      }

      return durationMs;
    }));

    return durations.reduce((total, duration) => total + duration, 0);
  }

  private runFfmpeg(
    argumentsList: string[],
    totalDurationMs: number,
    onProgress?: (progress: number) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const process = spawn(this.ffmpegPath, argumentsList);
      let stderr = "";
      let stdout = "";
      let lastProgress = -1;

      process.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("out_time_ms=") || !onProgress) {
            continue;
          }

          const outputTimeMs = Number.parseInt(line.slice("out_time_ms=".length), 10) / 1000;
          const progress = Math.min(99, Math.floor((outputTimeMs / totalDurationMs) * 100));

          if (Number.isFinite(progress) && progress > lastProgress) {
            lastProgress = progress;
            onProgress(progress);
          }
        }
      });
      process.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      process.on("error", reject);
      process.on("close", (code) => {
        if (code === 0) {
          onProgress?.(100);
          resolve();
          return;
        }

        reject(new Error(`FFmpeg exited with code ${code}: ${stderr}`));
      });
    });
  }

  private resolveUploadPath(filePath: string): string {
    const resolvedPath = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(this.uploadDirectory, filePath);
    const relativePath = path.relative(this.uploadDirectory, resolvedPath);

    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error("Relative paths must be inside the upload directory");
    }

    return resolvedPath;
  }

  private validateOptions(options: MergeVideosOptions): void {
    if (typeof options.width !== "number" || typeof options.height !== "number"
      || !Number.isInteger(options.width) || !Number.isInteger(options.height)
      || options.width <= 0 || options.height <= 0) {
      throw new Error("width and height must be positive integers");
    }

    for (const image of options.images || []) {
      if (!image.imagePath || image.startTime < 0 || image.duration <= 0) {
        throw new Error("Each image requires a path, a non-negative startTime, and a positive duration");
      }
    }
  }
}

export default FfmpegService;