import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { MergeVideosOptions } from "../models/MergeVideosOptions";
import { CONFIG } from "../config";
import { MergeVideosResult } from "../models/request-response/MergeVideosResult";
import { MergeVideoOutput } from "../models/request-response/MergeVideoOutput";
import { MergeVideosBatchResult } from "../models/request-response/MergeVideosBatchResult";
import { VideoImageOverlay } from "../models/VideoImageOverlay";

type CompositionMainImage = { imagePath: string; startTime: number; duration?: number };

const execFileAsync = promisify(execFile);

export class FfmpegService {
  private readonly ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
  private readonly uploadDirectory = path.resolve(process.env.UPLOAD_DIR || "uploads");
  private readonly mergedOutputDirectory = path.join(this.uploadDirectory, CONFIG.upload.mergedVideosFolder);

  async mergeVideosToOutputs(
    videoPaths: string[],
    outputs: MergeVideoOutput[],
    images: VideoImageOverlay[],
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

    await mkdir(this.mergedOutputDirectory, { recursive: true });
    const destinations = outputs.map((output) => output.outputPath
      ? this.resolveUploadPath(output.outputPath)
      : path.join(this.mergedOutputDirectory, `${randomUUID()}.mp4`));
    if (new Set(destinations).size !== destinations.length) {
      throw new Error("Each output must have a unique outputPath");
    }
    await Promise.all(destinations.map((destination) => mkdir(path.dirname(destination), { recursive: true })));

    const resolvedVideoPaths = videoPaths.map((videoPath) => this.resolveUploadPath(videoPath));
    const totalDurationMs = await this.getTotalDurationMs(resolvedVideoPaths);
    const mergeArguments = ["-y"];
    const filterParts: string[] = [];

    for (const videoPath of resolvedVideoPaths) {
      mergeArguments.push("-i", videoPath);
    }

    for (const [inputIndex] of resolvedVideoPaths.entries()) {
      const videoLabels = outputs.map((_, outputIndex) => `[sourceVideo${inputIndex}_${outputIndex}]`).join("");
      filterParts.push(`[${inputIndex}:v]split=${outputs.length}${videoLabels}`);
    }

    const audioConcatInputs = resolvedVideoPaths.map((_, inputIndex) => `[${inputIndex}:a]asetpts=PTS-STARTPTS[audio${inputIndex}]`).join(";");
    const audioInputs = resolvedVideoPaths.map((_, inputIndex) => `[audio${inputIndex}]`).join("");
    const outputAudioLabels = outputs.map((_, outputIndex) => `[outputAudio${outputIndex}]`).join("");
    filterParts.push(`${audioConcatInputs};${audioInputs}concat=n=${videoPaths.length}:v=0:a=1[mergedAudio]`);
    filterParts.push(`[mergedAudio]asplit=${outputs.length}${outputAudioLabels}`);

    const currentVideos: string[] = [];
    for (const [outputIndex, output] of outputs.entries()) {
      const concatInputs: string[] = [];
      for (const [inputIndex] of resolvedVideoPaths.entries()) {
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
      mergeArguments.push("-loop", "1", "-framerate", "25", "-t", String(endTime), "-i", this.resolveUploadPath(image.imagePath));
      filterParts.push(`[${imageInputIndex}:v]split=${outputs.length}${imageLabels}`);

      for (const [outputIndex, output] of outputs.entries()) {
        const outputLabel = `overlayVideo${outputIndex}_${imageIndex}`;
        filterParts.push(
          `[imageSource${imageIndex}_${outputIndex}]scale=${output.options.width}:${output.options.height},setsar=1[image${outputIndex}_${imageIndex}]`,
          `[${currentVideos[outputIndex]}][image${outputIndex}_${imageIndex}]overlay=0:0:enable='between(t,${image.startTime},${endTime})':eof_action=pass:repeatlast=0[${outputLabel}]`,
        );
        currentVideos[outputIndex] = outputLabel;
      }
      imageInputIndex++;
    }

    mergeArguments.push("-progress", "pipe:1", "-nostats", "-filter_complex", filterParts.join(";"));
    for (const [outputIndex, destination] of destinations.entries()) {
      mergeArguments.push("-map", `[${currentVideos[outputIndex]}]`, "-map", `[outputAudio${outputIndex}]`, "-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac", destination);
    }
    console.log(mergeArguments.join(" "));

    const startTime = performance.now();
    await this.runFfmpeg(mergeArguments, totalDurationMs, onProgress);
    const runTimeMs = Math.round(performance.now() - startTime);

    return {
      outputs: destinations.map((destination) => ({ path: destination, runTimeMs })),
      runTimeMs,
    };
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
    const openingDurationMs = await this.getTotalDurationMs(openingVideoPaths.map((videoPath) => this.resolveUploadPath(videoPath)));
    const mainDurationMs = await this.getTotalDurationMs([this.resolveUploadPath(mainVideoPath)]);
    const endingDurationMs = await this.getTotalDurationMs(endingVideoPaths.map((videoPath) => this.resolveUploadPath(videoPath))) + 0.1; // Add a small buffer to ensure the ending video is fully processed

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

  }

  private validateImages(images: VideoImageOverlay[]): void {
    for (const image of images) {
      if (!image.imagePath || image.startTime < 0 || image.duration <= 0) {
        throw new Error("Each image requires a path, a non-negative startTime, and a positive duration");
      }
    }
  }

  private offsetImages(
    images: VideoImageOverlay[],
    offsetMs: number,
    segmentDurationMs: number,
    sectionName: string,
  ): VideoImageOverlay[] {
    this.validateImages(images);
    return images.map((image) => {
      if ((image.startTime + image.duration) * 1000 > segmentDurationMs) {
        throw new Error(`${sectionName} image overlays must finish within the ${sectionName} video duration`);
      }
      return { ...image, startTime: image.startTime + offsetMs / 1000 };
    });
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