/**
 * Framework-neutral adapter for property-assessment-v1. NOT an HTTP endpoint.
 * A future route must call this only behind the existing, unchanged server guards
 * (auth/origin/rate/body-size). The caller injects a server-owned session made by
 * createDemoAssessment() or createResearchAssessment(); nothing in the body selects
 * the mode, factory, research data, citations or verification. No I/O happens here.
 */
import type { AssessmentResponse, PropertyAssessmentSession } from '../../shared/propertyAssessment';

export type AssessmentControllerBody =
  | AssessmentResponse
  | { error: { code: 'invalid-request'; messages: string[] } }
  | { error: { code: 'method-not-allowed' } }
  | { error: { code: 'internal-error' } };

export interface AssessmentControllerResult {
  status: 200 | 400 | 405 | 500;
  headers: Record<string, string>;
  body: AssessmentControllerBody;
}

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } as const;

export function handleAssessmentRequest(method: string, rawBody: unknown, service: PropertyAssessmentSession): AssessmentControllerResult {
  if (method !== 'POST') {
    return { status: 405, headers: { ...JSON_HEADERS, Allow: 'POST' }, body: { error: { code: 'method-not-allowed' } } };
  }
  try {
    const result = service.assess(rawBody); // validation is owned by the session
    if (result.ok) return { status: 200, headers: { ...JSON_HEADERS }, body: result.value };
    return { status: 400, headers: { ...JSON_HEADERS }, body: { error: { code: 'invalid-request', messages: [...result.error.messages] } } };
  } catch {
    return { status: 500, headers: { ...JSON_HEADERS }, body: { error: { code: 'internal-error' } } };
  }
}
