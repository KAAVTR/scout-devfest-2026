import type {VaGrowthRequest,VaGrowthResponse,VaGrowthProperty} from './vaGrowth';
export const SESSION_VERSION = 'va-growth-session-v1';
export interface DemoSnapshot {
  id: string; revision: number; expiresAt: string;
  request: unknown; assessment: VaGrowthResponse;
}
export type DemoSessionCommand = { op:'create'; request:VaGrowthRequest } | { op:'read'; id:string } | { op:'detail'; id:string; revision:number; propertyId:string } | { op:'recalculate'; id:string; revision:number; request:VaGrowthRequest } | { op:'delete'; id:string; revision:number };
export type DemoSessionBody = { contractVersion: typeof SESSION_VERSION; mode: 'va-growth-demo-only'; session: DemoSnapshot }
  | { contractVersion: typeof SESSION_VERSION; mode: 'va-growth-demo-only'; id: string; revision: number; expiresAt: string; property: VaGrowthProperty }
  | { deleted: true } | { error: { code: string } };
export interface SessionReply { status: number; body: DemoSessionBody; serializedBody: string; capability?: string }
