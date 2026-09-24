export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, details);
export const unauthorized = (msg = "no autorizado") => new HttpError(401, msg);
export const forbidden = (msg = "prohibido") => new HttpError(403, msg);
export const notFound = (msg = "no encontrado") => new HttpError(404, msg);
export const conflict = (msg: string) => new HttpError(409, msg);
