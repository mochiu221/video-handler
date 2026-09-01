import { HttpClient } from '@angular/common/http';
import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterOutlet } from '@angular/router';

type FileResource = { name: string; path: string; size: number; updatedAt: string; duration?: number };
type MergeJob = { id: string; type: string; status: 'queued' | 'running' | 'completed' | 'failed'; progress: number; createdAt: string; updatedAt: string; elapsedMs?: number; runTimeMs?: number; error?: string; detail: unknown; outputs?: { path: string; runTimeMs: number }[] };
type SectionImage = { imageFileName: string };
type MainImage = { imageFileName: string; startTime: number; duration?: number };
type OutputTarget = { suffix: string; width: number; height: number };
type AssetSection = { videoFileName: string; images: SectionImage[] };
type View = 'videos' | 'assets' | 'merge' | 'merged' | 'jobs';
type MergeEditorMode = 'form' | 'json';
type MergeCompositionRequest = {
  opening?: AssetSection;
  main: { videoFileName: string; images?: MainImage[] };
  ending?: AssetSection;
  outputs: { suffix: string; options: { width: number; height: number } }[];
};

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [FormsModule, RouterOutlet],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
})
export class AppComponent {
  private readonly http = inject(HttpClient);
  readonly apiUrl = '/api';
  activeView: View = 'videos';
  videos: FileResource[] = [];
  assets: FileResource[] = [];
  mergedVideos: FileResource[] = [];
  jobs: MergeJob[] = [];
  mainVideoFileName = '';
  opening: AssetSection = { videoFileName: '', images: [] };
  mainImages: MainImage[] = [];
  ending: AssetSection = { videoFileName: '', images: [] };
  outputTargets: OutputTarget[] = [{ suffix: '_1080', width: 1920, height: 1080 }];
  mergeEditorMode: MergeEditorMode = 'form';
  mergeJson = '';
  progress: number | null = null;
  mergeStatus = '';
  error = '';
  uploading: 'video' | 'asset' | null = null;
  deletingPath: string | null = null;
  private jobRefreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.refreshAll();
  }

  setView(view: View): void {
    if (this.jobRefreshTimer) {
      clearInterval(this.jobRefreshTimer);
      this.jobRefreshTimer = null;
    }
    this.activeView = view;
    this.error = '';
    if (view === 'videos') this.loadFiles('videos');
    if (view === 'assets') this.loadFiles('assets');
    if (view === 'merged') this.loadFiles('merged');
    if (view === 'jobs') {
      this.loadJobs();
      this.jobRefreshTimer = setInterval(() => this.loadJobs(), 2000);
    }
  }

  refreshAll(): void {
    this.loadFiles('videos');
    this.loadFiles('assets');
    this.loadFiles('merged');
  }

  get imageAssets(): FileResource[] {
    return this.assets.filter((asset) => /\.(png|jpe?g|webp)$/i.test(asset.name));
  }

  get videoAssets(): FileResource[] {
    return this.assets.filter((asset) => this.isVideoAsset(asset));
  }

  loadFiles(type: 'videos' | 'assets' | 'merged'): void {
    this.http.get<FileResource[]>(`${this.apiUrl}/uploads/list-files/${type}`).subscribe({
      next: (files) => {
        if (type === 'videos') this.videos = files;
        if (type === 'assets') this.assets = files;
        if (type === 'merged') this.mergedVideos = files;
      },
      error: () => this.error = `Could not load ${type}. Start the video-handler server and try again.`,
    });
  }

  loadJobs(): void {
    this.http.get<MergeJob[]>(`${this.apiUrl}/video/jobs`).subscribe({
      next: (jobs) => this.jobs = jobs,
      error: () => this.error = 'Could not load merge jobs.',
    });
  }

  upload(type: 'video' | 'asset', event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;

    this.uploading = type;
    this.error = '';
    const body = new FormData();
    body.append('file', file);
    this.http.post(`${this.apiUrl}/uploads/upload-${type}`, body).subscribe({
      next: () => {
        this.uploading = null;
        this.loadFiles(type === 'video' ? 'videos' : 'assets');
        (event.target as HTMLInputElement).value = '';
      },
      error: () => {
        this.uploading = null;
        this.error = `Could not upload ${file.name}.`;
      },
    });
  }

  deleteFile(type: 'videos' | 'assets' | 'merged', file: FileResource): void {
    if (this.deletingPath || !confirm(`Delete ${file.name}?`)) return;

    this.deletingPath = file.path;
    this.error = '';
    this.http.delete(`${this.apiUrl}/uploads/file/${type}/${encodeURIComponent(file.name)}`).subscribe({
      next: () => {
        if (type === 'videos' && this.mainVideoFileName === file.name) this.mainVideoFileName = '';
        if (type === 'assets') {
          this.opening = { videoFileName: this.opening.videoFileName === file.name ? '' : this.opening.videoFileName, images: this.opening.images.filter((image) => image.imageFileName !== file.name) };
          this.mainImages = this.mainImages.filter((image) => image.imageFileName !== file.name);
          this.ending = { videoFileName: this.ending.videoFileName === file.name ? '' : this.ending.videoFileName, images: this.ending.images.filter((image) => image.imageFileName !== file.name) };
        }
        this.loadFiles(type);
        this.deletingPath = null;
      },
      error: () => {
        this.error = `Could not delete ${file.name}.`;
        this.deletingPath = null;
      },
    });
  }

  isVideoAsset(file: FileResource): boolean {
    return file.duration !== undefined;
  }

  addOverlay(section: 'opening' | 'main' | 'ending'): void {
    const asset = this.imageAssets[0];
    if (!asset) {
      this.error = 'Upload an image asset before adding an overlay.';
      return;
    }
    if (section === 'main') {
      this.mainImages = [...this.mainImages, { imageFileName: asset.name, startTime: 0 }];
    } else {
      this[section] = { ...this[section], images: [...this[section].images, { imageFileName: asset.name }] };
    }
  }

  removeOverlay(section: 'opening' | 'main' | 'ending', index: number): void {
    if (section === 'main') {
      this.mainImages = this.mainImages.filter((_, overlayIndex) => overlayIndex !== index);
    } else {
      this[section] = { ...this[section], images: this[section].images.filter((_, overlayIndex) => overlayIndex !== index) };
    }
  }

  addOutputTarget(): void {
    const previous = this.outputTargets.at(-1) || { suffix: '_1080', width: 1920, height: 1080 };
    this.outputTargets = [...this.outputTargets, { ...previous, suffix: '' }];
  }

  removeOutputTarget(index: number): void {
    if (this.outputTargets.length > 1) {
      this.outputTargets = this.outputTargets.filter((_, targetIndex) => targetIndex !== index);
    }
  }

  setMergeEditorMode(mode: MergeEditorMode): void {
    if (mode === 'json') this.mergeJson = JSON.stringify(this.mergeRequest(), null, 2);
    this.mergeEditorMode = mode;
    this.error = '';
  }

  async merge(): Promise<void> {
    if (this.progress !== null) return;

    let mergeRequest: MergeCompositionRequest;
    try {
      mergeRequest = this.mergeEditorMode === 'json'
        ? this.parseMergeJson()
        : this.mergeRequest();
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Invalid merge JSON.';
      return;
    }
    if (!mergeRequest.main.videoFileName) {
      this.error = 'Select the required main video.';
      return;
    }

    this.progress = 0;
    this.mergeStatus = 'Preparing media';
    this.error = '';
    try {
      const response = await fetch(`${this.apiUrl}/video/merge-composition?progress=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mergeRequest),
      });
      if (!response.ok || !response.body) throw new Error('Merge request could not be started.');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      while (true) {
        const { done, value } = await reader.read();
        pending += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = pending.split('\n');
        pending = lines.pop() || '';
        for (const line of lines) this.handleMergeEvent(line);
        if (done) break;
      }
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Merge failed.';
      this.mergeStatus = '';
    } finally {
      this.progress = null;
    }
  }

  private handleMergeEvent(line: string): void {
    if (!line.trim()) return;
    const event = JSON.parse(line) as { type: string; position?: number; progress?: number; error?: string; runTimeMs?: number };
    if (event.type === 'progress') {
      this.progress = event.progress ?? 0;
      this.mergeStatus = `Rendering ${this.progress}%`;
	} else if (event.type === 'queued') {
	  this.mergeStatus = `Queued (position ${event.position ?? 1})`;
    } else if (event.type === 'complete') {
      this.progress = 100;
      this.mergeStatus = `Complete in ${((event.runTimeMs || 0) / 1000).toFixed(1)} seconds`;
      this.loadFiles('merged');
      this.loadJobs();
    } else if (event.type === 'error') {
      this.error = event.error || 'Merge failed.';
    }
  }

  private mergeRequest(): MergeCompositionRequest {
    return {
      ...(this.opening.videoFileName ? { opening: this.opening } : {}),
      main: { videoFileName: this.mainVideoFileName, ...(this.mainImages.length ? { images: this.mainImages } : {}) },
      ...(this.ending.videoFileName ? { ending: this.ending } : {}),
      outputs: this.outputTargets.map((target) => ({
        suffix: target.suffix.trim(),
        options: { width: Number(target.width), height: Number(target.height) },
      })),
    };
  }

  private parseMergeJson(): MergeCompositionRequest {
    const request = JSON.parse(this.mergeJson) as MergeCompositionRequest;
    if (!request.main || typeof request.main.videoFileName !== 'string') {
      throw new Error('Merge JSON must include main.videoFileName.');
    }
    if (!Array.isArray(request.outputs) || request.outputs.length === 0 || request.outputs.some((output) =>
      typeof output.suffix !== 'string' || !output.suffix || !output.options
      || !Number.isFinite(output.options.width) || !Number.isFinite(output.options.height)
      )) {
      throw new Error('Merge JSON must include an outputs array with options for each output.');
    }
    return request;
  }

  fileUrl(file: FileResource): string {
    return `${this.apiUrl}/uploads/file/${file.path}`;
  }

  formatSize(bytes: number): string {
    return bytes < 1_000_000 ? `${Math.round(bytes / 1_000)} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`;
  }

  formatUpdatedAt(updatedAt: string): string {
    return new Date(updatedAt).toLocaleString();
  }

  formatDuration(milliseconds: number | undefined): string {
    if (milliseconds === undefined) return '-';
    const totalSeconds = Math.round(milliseconds / 1000);
    return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
  }

  outputUrl(outputPath: string): string {
    return `${this.apiUrl}/uploads/file/${outputPath}`;
  }

  formatJobDetail(detail: unknown): string {
    return JSON.stringify(detail, null, 2);
  }
}
