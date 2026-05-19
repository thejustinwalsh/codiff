import type {
  CodiffPreferences,
  DiffSection,
  DiffSectionContentRequest,
  DifftRunRequest,
  DifftRunResult,
  RepositoryHistory,
  RepositoryState,
  ReviewSource,
} from './types.ts';

declare global {
  interface Window {
    codiff: {
      getDiffSectionContent: (request: DiffSectionContentRequest) => Promise<DiffSection>;
      getPreferences: () => Promise<CodiffPreferences>;
      getRepositoryHistory: (limit?: number) => Promise<RepositoryHistory>;
      getRepositoryState: (source?: ReviewSource) => Promise<RepositoryState>;
      isDifftAvailable: () => Promise<boolean>;
      onPreferencesChanged: (callback: (preferences: CodiffPreferences) => void) => () => void;
      onRepositoryChanged: (callback: (change: { root: string }) => void) => () => void;
      refreshDifftAvailability: () => Promise<boolean>;
      runDifft: (request: DifftRunRequest) => Promise<DifftRunResult>;
      showInFolder: (path: string) => Promise<void>;
    };
  }
}
