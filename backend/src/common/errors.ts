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
