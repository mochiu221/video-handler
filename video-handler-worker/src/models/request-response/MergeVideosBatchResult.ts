export type MergeVideosBatchResult = {
  outputs: { path: string; runTimeMs: number }[];
  runTimeMs: number;
};