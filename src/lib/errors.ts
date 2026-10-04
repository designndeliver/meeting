export type ErrorCode =
  | 'bad_request'
  | 'geocode_failed'
  | 'no_pois'
  | 'quota'
  | 'rate_limited'
  | 'upstream'
  | 'config';

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  geocode_failed: 404,
  no_pois: 404,
  quota: 429,
  rate_limited: 429,
  upstream: 502,
  config: 500,
};

export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
  get status() {
    return STATUS[this.code];
  }
}

export const UA = 'MeetingPoint/1.0 (+https://meeting.vinaygoel.com; contact via vinaygoel.com)';
