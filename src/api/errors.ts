export class ApiError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 503,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// Hackathon response contract: never emit application HTTP 429 while bypass is
// enabled. Provider failures stay failures; this does not bypass upstream limits.
export function apiErrorStatus(error: ApiError, bypassQuotas: boolean): ApiError["status"] {
  return bypassQuotas && error.status === 429 ? 503 : error.status;
}
