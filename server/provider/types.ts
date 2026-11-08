import type { Citation, ProviderFailure } from '../../shared/research';

export type GroundedResult =
  | { ok: true; text: string; citations: Citation[]; searchQueries: string[]; model: string }
  | { ok: false; failure: ProviderFailure };

export interface GroundedSearchRequest {
  prompt: string;
  schema: Record<string, unknown>;
  deadlineMs: number; // absolute epoch ms
}

export interface GroundedSearchProvider {
  readonly name: 'gemini';
  readonly model: string;
  readonly configured: boolean;
  search(req: GroundedSearchRequest, signal: AbortSignal): Promise<GroundedResult>;
}
