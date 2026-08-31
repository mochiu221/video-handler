import { MergeVideosResult } from "./MergeVideosResult";

export type MergeVideosBatchResult = {
  outputs: MergeVideosResult[];
  runTimeMs: number;
};