import { HttpClient } from '@angular/common/http';
import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterOutlet } from '@angular/router';

type FileResource = { name: string; path: string; size: number; updatedAt: string; duration?: number };
type Overlay = { imagePath: string; startTime: number; duration: number };
type OutputTarget = { outputPath: string; width: number; height: number };
type View = 'videos' | 'assets' | 'merge' | 'merged';
type MergeEditorMode = 'form' | 'json';
type MergeRequest = { videoPaths: string[]; images?: Overlay[]; outputs: { outputPath?: string; options: { width: number; height: number } }[] };

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
  selectedVideos: FileResource[] = [];
  overlays: Overlay[] = [];
  outputTargets: OutputTarget[] = [{ outputPath: '', width: 1280, height: 720 }];
  mergeEditorMode: MergeEditorMode = 'form';
  mergeJson = '';
  progress: number | null = null;
  mergeStatus = '';
  error = '';
  uploading: 'video' | 'asset' | null = null;

  constructor() {
    this.refreshAll();
  }

  setView(view: View): void {
    this.activeView = view;
    this.error = '';
    if (view === 'videos') this.loadFiles('videos');
    if (view === 'assets') this.loadFiles('assets');
    if (view === 'merged') this.loadFiles('merged');
  }

  refreshAll(): void {
    this.loadFiles('videos');
    this.loadFiles('assets');
    this.loadFiles('merged');
  }

  get imageAssets(): FileResource[] {
    return this.assets.filter((asset) => /\.(png|jpe?g|webp)$/i.test(asset.name));
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

  isSelected(video: FileResource): boolean {
    return this.selectedVideos.some((selected) => selected.path === video.path);
  }

  toggleVideo(video: FileResource): void {
    this.selectedVideos = this.isSelected(video)
      ? this.selectedVideos.filter((selected) => selected.path !== video.path)
      : [...this.selectedVideos, video];
  }

  moveVideo(index: number, direction: number): void {
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= this.selectedVideos.length) return;
    const ordered = [...this.selectedVideos];
    [ordered[index], ordered[targetIndex]] = [ordered[targetIndex], ordered[index]];
    this.selectedVideos = ordered;
  }

  removeVideo(video: FileResource): void {
    this.selectedVideos = this.selectedVideos.filter((selected) => selected.path !== video.path);
  }

  isVideoAsset(file: FileResource): boolean {
    return file.duration !== undefined;
  }

  addOverlay(): void {
    const asset = this.imageAssets[0];
    if (!asset) {
      this.error = 'Upload an image asset before adding an overlay.';
      return;
    }
    this.overlays = [...this.overlays, { imagePath: asset.path, startTime: 0, duration: 3 }];
  }

  removeOverlay(index: number): void {
    this.overlays = this.overlays.filter((_, overlayIndex) => overlayIndex !== index);
  }

  addOutputTarget(): void {
    const previous = this.outputTargets.at(-1) || { outputPath: '', width: 1280, height: 720 };
    this.outputTargets = [...this.outputTargets, { ...previous, outputPath: '' }];
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

    let mergeRequest: MergeRequest;
    try {
      mergeRequest = this.mergeEditorMode === 'json'
        ? this.parseMergeJson()
        : this.mergeRequest();
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'Invalid merge JSON.';
      return;
    }
    if (mergeRequest.videoPaths.length < 2) {
      this.error = 'Select or provide at least two video paths.';
      return;
    }

    this.progress = 0;
    this.mergeStatus = 'Preparing media';
    this.error = '';
    try {
      const response = await fetch(`${this.apiUrl}/video/merge?progress=true`, {
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
    const event = JSON.parse(line) as { type: string; progress?: number; error?: string; runTimeMs?: number };
    if (event.type === 'progress') {
      this.progress = event.progress ?? 0;
      this.mergeStatus = `Rendering ${this.progress}%`;
    } else if (event.type === 'complete') {
      this.progress = 100;
      this.mergeStatus = `Complete in ${((event.runTimeMs || 0) / 1000).toFixed(1)} seconds`;
      this.loadFiles('merged');
    } else if (event.type === 'error') {
      this.error = event.error || 'Merge failed.';
    }
  }

  private mergeRequest(): MergeRequest {
    return {
      videoPaths: this.selectedVideos.map((video) => video.path),
      images: this.overlays,
      outputs: this.outputTargets.map((target) => ({
        ...(target.outputPath.trim() ? { outputPath: target.outputPath.trim() } : {}),
        options: { width: Number(target.width), height: Number(target.height) },
      })),
    };
  }

  private parseMergeJson(): MergeRequest {
    const request = JSON.parse(this.mergeJson) as MergeRequest;
    if (!Array.isArray(request.videoPaths) || !request.videoPaths.every((path) => typeof path === 'string')) {
      throw new Error('Merge JSON must include a videoPaths array of strings.');
    }
    if ((request.images !== undefined && !Array.isArray(request.images))
      || !Array.isArray(request.outputs) || request.outputs.length === 0 || request.outputs.some((output) =>
      !output.options || !Number.isFinite(output.options.width) || !Number.isFinite(output.options.height)
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
}
