import type { AssessmentRequest, AssessmentResponse, PropertyAssessment } from './propertyAssessment';
export const SESSION_VERSION = 'demo-session-v1';
export interface DemoSnapshot {
  id: string; revision: number; expiresAt: string;
  request: unknown; assessment: AssessmentResponse;
}
export type DemoSessionCommand = { op:'create'; request:AssessmentRequest } | { op:'read'; id:string } | { op:'detail'; id:string; revision:number; propertyId:string } | { op:'recalculate'; id:string; revision:number; request:AssessmentRequest } | { op:'delete'; id:string; revision:number };
export type DemoSessionBody = { contractVersion: typeof SESSION_VERSION; mode: 'demo-only'; session: DemoSnapshot }
  | { contractVersion: typeof SESSION_VERSION; mode: 'demo-only'; id: string; revision: number; expiresAt: string; property: PropertyAssessment }
  | { deleted: true } | { error: { code: string } };
export interface SessionReply { status: number; body: DemoSessionBody; serializedBody: string; capability?: string }
