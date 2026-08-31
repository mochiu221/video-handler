export interface Config {
    upload: UploadConfig;
}

interface UploadConfig {
    assetsFolder: string;
    uploadVideosFolder: string;
    mergedVideosFolder: string;
}