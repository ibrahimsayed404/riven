import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * The one error shape every endpoint returns. Success bodies are the bare
 * service result; there is deliberately no `success` envelope on either side
 * (fix.js API-01). `details` is optional structured context — e.g. the list of
 * cart lines that failed at checkout — and is passed through untouched.
 */
export type ErrorBody = {
  code: string;
  message: string | string[];
  details?: unknown;
};

type Resolved = { status: number; body: ErrorBody };

function fromHttpException(exception: HttpException): Resolved {
  const status = exception.getStatus();
  const response = exception.getResponse();

  if (typeof response === 'object' && response !== null && 'code' in response && 'message' in response) {
    const { code, message, details } = response as ErrorBody;
    return { status, body: details === undefined ? { code, message } : { code, message, details } };
  }

  // Bare-string throws and Nest's own exceptions (guards, pipes without a custom
  // factory) land here. Clients cannot branch on HTTP_ERROR — see fix.js ERR-01.
  if (typeof response === 'object' && response !== null && 'message' in response) {
    const { message } = response as { message: string | string[] };
    return { status, body: { code: 'HTTP_ERROR', message } };
  }

  return { status, body: { code: 'HTTP_ERROR', message: exception.message } };
}

/**
 * Known Prisma failures caused by the caller's input are 4xx, not 500. Anything
 * else stays a 500 so a real bug is never dressed up as a client error.
 */
function fromPrismaError(error: Prisma.PrismaClientKnownRequestError): Resolved | null {
  const target = (error.meta as { target?: string[] | string } | undefined)?.target;
  const field = Array.isArray(target) ? target.join(', ') : target;

  switch (error.code) {
    case 'P2002':
      return {
        status: HttpStatus.CONFLICT,
        body: { code: 'UNIQUE_VIOLATION', message: field ? `${field} must be unique.` : 'Value must be unique.' },
      };
    case 'P2003':
      return {
        status: HttpStatus.BAD_REQUEST,
        body: { code: 'INVALID_REFERENCE', message: 'A referenced record does not exist.' },
      };
    case 'P2025':
      return { status: HttpStatus.NOT_FOUND, body: { code: 'NOT_FOUND', message: 'Record not found.' } };
    default:
      return null;
  }
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const context = host.switchToHttp();
    const response = context.getResponse<{ status(code: number): { json(body: unknown): void } }>();
    const request = context.getRequest<{ method: string; url: string; user?: { id?: string } }>();

    const resolved = this.resolve(exception);

    if (resolved.status >= 500) {
      // Without this line a 500 leaves no trace on the server (fix.js LOG-02).
      this.logger.error(
        `${request.method} ${request.url} -> ${resolved.status} ${resolved.body.code}` +
          (request.user?.id ? ` (user ${request.user.id})` : ''),
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(resolved.status).json(resolved.body);
  }

  private resolve(exception: unknown): Resolved {
    if (exception instanceof HttpException) {
      return fromHttpException(exception);
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      const mapped = fromPrismaError(exception);
      if (mapped) return mapped;
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' },
    };
  }
}
