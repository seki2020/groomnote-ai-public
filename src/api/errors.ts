export class ApiError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 503,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
