import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';

type ErrorResponse = {
  success: false;
  error: {
    code: string;
    message: string | string[];
  };
};

function getErrorBody(exception: unknown): ErrorResponse['error'] {
  if (exception instanceof HttpException) {
    const response = exception.getResponse();

    if (
      typeof response === 'object' &&
      response !== null &&
      'code' in response &&
      'message' in response
    ) {
      const { code, message } = response as { code: string; message: string | string[] };
      return { code, message };
    }

    if (typeof response === 'object' && response !== null && 'message' in response) {
      const { message } = response as { message: string | string[] };
      return { code: 'HTTP_ERROR', message };
    }

    return { code: 'HTTP_ERROR', message: exception.message };
  }

  return { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' };
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const context = host.switchToHttp();
    const response = context.getResponse();
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    response.status(status).json({
      success: false,
      error: getErrorBody(exception),
    });
  }
}
