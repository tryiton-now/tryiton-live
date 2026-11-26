/**
 * Every failure the SDK reports. `code` is stable for branching; `status` / `name` mirror the backend's
 * `{ ok: false, error: { name, message } }` when the API answered.
 */
export type LiveErrorCode =
  | "camera_denied"
  | "camera_unavailable"
  | "garment_required"
  | "busy"
  | "connect_failed"
  | "heartbeat_failed"
  | "http_error";

export class TryItOnLiveError extends Error {
  readonly code: LiveErrorCode;
  readonly status: number | null;
  readonly apiName: string | null;

  constructor(code: LiveErrorCode, message: string, { status = null, apiName = null }: { status?: number | null; apiName?: string | null } = {}) {
    super(message);
    this.name = "TryItOnLiveError";
    this.code = code;
    this.status = status;
    this.apiName = apiName;
  }
}
