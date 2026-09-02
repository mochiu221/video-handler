import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { MergeVideosOptions } from "../models/MergeVideosOptions";
import { CONFIG } from "../config";
import { MergeVideoOutput } from "../models/request-response/MergeVideoOutput";
import { MergeVideosBatchResult } from "../models/request-response/MergeVideosBatchResult";
import { VideoImageOverlay } from "../models/VideoImageOverlay";
import FileStorageService from "./file-storage.service";

type CompositionMainImage = { imagePath: string; startTime: number; duration?: number };

const execFileAsync = promisify(execFile);

export class FfmpegService {
  private readonly ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
  private readonly videoCodec = process.env.FFMPEG_VIDEO_CODEC || "libx264";
  private readonly videoPreset = process.env.FFMPEG_VIDEO_PRESET || "ultrafast"; // veryfast (default), ultrafast (faster encoding, larger file size)
  private readonly encoderThreads = process.env.FFMPEG_ENCODER_THREADS || null;
  private readonly storage = new FileStorageService();

  async mergeVideosToOutputs(
    videoPaths: string[],
    outputs: MergeVideoOutput[],
    images: VideoImageOverlay[],
    onProgress?: (progress: number) => void,
  ): Promise<MergeVideosBatchResult> {
    const temporaryDirectory = await mkdtemp(path.join(process.env.TMPDIR || "/tmp", "video-handler-"));
    try {
      const localVideoPaths = await Promise.all(videoPaths.map((videoPath) => this.storage.downloadToFile(videoPath, temporaryDirectory)));
      const localImages = await Promise.all(images.map(async (image) => ({
        ...image,
        imagePath: await this.storage.downloadToFile(image.imagePath, temporaryDirectory),
      })));
      const normalizedOutputs = outputs.map((output) => ({
        ...output,
        outputPath: output.outputPath || path.posix.join(CONFIG.upload.mergedVideosFolder, `${randomUUID()}.mp4`),
      }));
      return await this.mergeVideosToOutputsLocal(localVideoPaths, normalizedOutputs, localImages, temporaryDirectory, onProgress);
    } finally {
      await this.storage.cleanup(temporaryDirectory);
    }
  }

  private async mergeVideosToOutputsLocal(
    videoPaths: string[],
    outputs: MergeVideoOutput[],
    images: VideoImageOverlay[],
    temporaryDirectory: string,
    onProgress?: (progress: number) => void,
  ): Promise<MergeVideosBatchResult> {
    if (videoPaths.length === 0) {
      throw new Error("At least one video path is required");
    }
    if (outputs.length === 0) {
      throw new Error("At least one output is required");
    }

    for (const output of outputs) {
      this.validateOptions(output.options);
    }
    this.validateImages(images);

    const outputPaths = outputs.map((output) => output.outputPath as string);
    const destinations = outputPaths.map((_outputPath, outputIndex) => path.join(temporaryDirectory, `output-${outputIndex}.mp4`));
    if (new Set(destinations).size !== destinations.length) {
      throw new Error("Each output must have a unique outputPath");
    }
    const totalDurationMs = await this.getTotalDurationMs(videoPaths);
    const mergeArguments = ["-y"];
    const filterParts: string[] = [];

    for (const videoPath of videoPaths) {
      mergeArguments.push("-i", videoPath);
    }

    for (const [inputIndex] of videoPaths.entries()) {
      const videoLabels = outputs.map((_, outputIndex) => `[sourceVideo${inputIndex}_${outputIndex}]`).join("");
      filterParts.push(`[${inputIndex}:v]split=${outputs.length}${videoLabels}`);
    }

    const audioConcatInputs = videoPaths.map((_, inputIndex) => `[${inputIndex}:a]asetpts=PTS-STARTPTS[audio${inputIndex}]`).join(";");
    const audioInputs = videoPaths.map((_, inputIndex) => `[audio${inputIndex}]`).join("");
    const outputAudioLabels = outputs.map((_, outputIndex) => `[outputAudio${outputIndex}]`).join("");
    filterParts.push(`${audioConcatInputs};${audioInputs}concat=n=${videoPaths.length}:v=0:a=1[mergedAudio]`);
    filterParts.push(`[mergedAudio]asplit=${outputs.length}${outputAudioLabels}`);

    const currentVideos: string[] = [];
    for (const [outputIndex, output] of outputs.entries()) {
      const concatInputs: string[] = [];
      for (const [inputIndex] of videoPaths.entries()) {
        filterParts.push(
          `[sourceVideo${inputIndex}_${outputIndex}]scale=${output.options.width}:${output.options.height}:force_original_aspect_ratio=decrease,pad=${output.options.width}:${output.options.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,setpts=PTS-STARTPTS[video${inputIndex}_${outputIndex}]`,
        );
        concatInputs.push(`[video${inputIndex}_${outputIndex}]`);
      }
      filterParts.push(`${concatInputs.join("")}concat=n=${videoPaths.length}:v=1:a=0[mergedVideo${outputIndex}]`);
      currentVideos.push(`mergedVideo${outputIndex}`);
    }

    let imageInputIndex = videoPaths.length;
    for (const [imageIndex, image] of images.entries()) {
      const endTime = image.startTime + image.duration;
      const imageLabels = outputs.map((_, outputIndex) => `[imageSource${imageIndex}_${outputIndex}]`).join("");
      mergeArguments.push("-loop", "1", "-framerate", "1", "-t", String(totalDurationMs / 1000), "-i", image.imagePath);
      filterParts.push(`[${imageInputIndex}:v]split=${outputs.length}${imageLabels}`);

      for (const [outputIndex, output] of outputs.entries()) {
        const outputLabel = `overlayVideo${outputIndex}_${imageIndex}`;
        filterParts.push(
          `[imageSource${imageIndex}_${outputIndex}]scale=${output.options.width}:${output.options.height},setsar=1[image${outputIndex}_${imageIndex}]`,
          `[${currentVideos[outputIndex]}][image${outputIndex}_${imageIndex}]overlay=0:0:enable='gte(t,${image.startTime})*lt(t,${endTime})':eof_action=pass:repeatlast=1[${outputLabel}]`,
        );
        currentVideos[outputIndex] = outputLabel;
      }
      imageInputIndex++;
    }

    mergeArguments.push("-progress", "pipe:1", "-nostats", "-filter_complex", filterParts.join(";"));
    for (const [outputIndex, destination] of destinations.entries()) {
      mergeArguments.push(
        "-map", `[${currentVideos[outputIndex]}]`, "-map", `[outputAudio${outputIndex}]`,
        "-c:v", this.videoCodec, "-preset", this.videoPreset,
        ...(this.encoderThreads !== null ? ["-threads", this.encoderThreads] : []),
        "-c:a", "aac", destination,
      );
    }
    console.log(mergeArguments.join(" "));

    const startTime = performance.now();
    await this.runFfmpeg(mergeArguments, totalDurationMs, onProgress);
    const runTimeMs = Math.round(performance.now() - startTime);

    await Promise.all(destinations.map((destination, outputIndex) => this.storage.uploadFile(outputPaths[outputIndex], destination)));
    return { outputs: outputPaths.map((outputPath) => ({ path: outputPath, runTimeMs })), runTimeMs };
  }

  async mergeVideoComposition(
    openingVideoPaths: string[],
    openingImagePaths: string[],
    mainVideoPath: string,
    mainImages: CompositionMainImage[],
    endingVideoPaths: string[],
    endingImagePaths: string[],
    outputs: MergeVideoOutput[],
    onProgress?: (progress: number) => void,
  ): Promise<MergeVideosBatchResult> {
    const openingDurationMs = await this.getObjectDurationMs(openingVideoPaths);
    const mainDurationMs = await this.getObjectDurationMs([mainVideoPath]);
    const endingDurationMs = await this.getObjectDurationMs(endingVideoPaths) + 100;

    const images = [
      ...this.fullSectionImages(openingImagePaths, 0, openingDurationMs),
      ...this.mainSectionImages(mainImages, openingDurationMs, mainDurationMs),
      ...this.fullSectionImages(endingImagePaths, openingDurationMs + mainDurationMs, endingDurationMs),
    ];

    return this.mergeVideosToOutputs(
      [...openingVideoPaths, mainVideoPath, ...endingVideoPaths],
      outputs,
      images,
      onProgress,
    );
  }

  async createThumbnail(videoObjectPath: string): Promise<string> {
    const temporaryDirectory = await mkdtemp(path.join(process.env.TMPDIR || "/tmp", "video-handler-"));
    try {
      const localVideoPath = await this.storage.downloadToFile(videoObjectPath, temporaryDirectory);
      const thumbnailPath = path.posix.join(CONFIG.upload.snapshotsFolder, `${path.posix.parse(videoObjectPath).name}.png`);
      const localThumbnailPath = path.join(temporaryDirectory, "thumbnail.png");
      await this.captureFrame(localVideoPath, localThumbnailPath);
      await this.storage.uploadFile(thumbnailPath, localThumbnailPath, "image/png");
      return thumbnailPath;
    } finally {
      await this.storage.cleanup(temporaryDirectory);
    }
  }

  private async getTotalDurationMs(videoPaths: string[]): Promise<number> {
    if (videoPaths.length === 0) {
      return 0;
    }

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

  private async getObjectDurationMs(objectPaths: string[]): Promise<number> {
    const temporaryDirectory = await mkdtemp(path.join(process.env.TMPDIR || "/tmp", "video-handler-"));
    try {
      const localPaths = await Promise.all(objectPaths.map((objectPath) => this.storage.downloadToFile(objectPath, temporaryDirectory)));
      return await this.getTotalDurationMs(localPaths);
    } finally {
      await this.storage.cleanup(temporaryDirectory);
    }
  }

  private async captureFrame(videoPath: string, imagePath: string): Promise<void> {
    await execFileAsync(this.ffmpegPath, [
      "-y", "-ss", "0", "-i", videoPath, "-frames:v", "1", "-q:v", "2", imagePath,
    ]);
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

  private validateOptions(options: MergeVideosOptions): void {
    if (typeof options.width !== "number" || typeof options.height !== "number"
      || !Number.isInteger(options.width) || !Number.isInteger(options.height)
      || options.width <= 0 || options.height <= 0) {
      throw new Error("width and height must be positive integers");
    }

  }

  private validateImages(images: VideoImageOverlay[]): void {
    for (const image of images) {
      if (!image.imagePath || image.startTime < 0 || image.duration <= 0) {
        throw new Error("Each image requires a path, a non-negative startTime, and a positive duration");
      }
    }
  }

  private fullSectionImages(imagePaths: string[], offsetMs: number, durationMs: number): VideoImageOverlay[] {
    return imagePaths.map((imagePath) => ({ imagePath, startTime: offsetMs / 1000, duration: durationMs / 1000 }));
  }

  private mainSectionImages(images: CompositionMainImage[], offsetMs: number, durationMs: number): VideoImageOverlay[] {
    return images.map((image) => {
      if (!image.imagePath || image.startTime < 0) {
        throw new Error("Each main image requires a path and a non-negative startTime");
      }
      const duration = image.duration ?? durationMs / 1000 - image.startTime;
      if (duration <= 0 || (image.startTime + duration) * 1000 > durationMs) {
        throw new Error("Main image overlays must finish within the main video duration");
      }
      return { imagePath: image.imagePath, startTime: image.startTime + offsetMs / 1000, duration };
    });
  }
}

export default FfmpegService;