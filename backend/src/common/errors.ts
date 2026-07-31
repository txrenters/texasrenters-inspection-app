import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';

export class ApplicationError extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    message: string,
    readonly details: unknown[] = [],
  ) {
    super(message, status);
  }
}

/**
 * The constraint messages behind a 400, without the submitted values.
 *
 * Nest's ValidationPipe puts its messages in the response body. Those name the
 * failing field and rule — "clockwiseRotationDegrees must not be greater than
 * 720" — and are safe to log. The payload itself is inspection content and is
 * deliberately never touched here.
 */
function describeValidationFailure(exception: unknown): string {
  if (!(exception instanceof HttpException)) return 'unknown validation failure';
  const body = exception.getResponse();
  if (typeof body === 'string') return body;
  const message = (body as { message?: unknown }).message;
  if (Array.isArray(message)) return message.join('; ');
  if (typeof message === 'string') return message;
  return exception.message;
}

@Catch()
export class ApplicationExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const request = host.switchToHttp().getRequest<Request & { requestId?: string }>();
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    // Unexpected exceptions must leave a trace; without this, every raw 500
    // is undiagnosable from the client side.
    if (status >= 500)
      this.logger.error(
        `${request.method} ${request.url} -> ${status} (requestId=${request.requestId ?? 'unknown'})`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    // Rejected requests were silent, and a validation failure says nothing
    // useful from the client: a room video that uploaded fully and was then
    // refused for one out-of-range field left no record anywhere of which
    // field it was. Logged at warn, and only the constraint messages — never
    // the submitted values, which carry inspection content.
    else if (status === 400)
      this.logger.warn(
        `${request.method} ${request.url} -> 400 (requestId=${
          request.requestId ?? 'unknown'
        }): ${describeValidationFailure(exception)}`,
      );
    const isApplication = exception instanceof ApplicationError;
    const rawMessage =
      exception instanceof HttpException ? exception.message : 'Unexpected server error';
    response.status(status).json({
      statusCode: status,
      code: isApplication ? exception.code : status === 400 ? 'VALIDATION_ERROR' : 'REQUEST_FAILED',
      message: isApplication || status < 500 ? rawMessage : 'The request could not be completed.',
      details: isApplication ? exception.details : [],
      requestId: request.requestId ?? 'unknown',
    });
  }
}
