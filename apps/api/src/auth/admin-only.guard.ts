import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import type { User } from '../../generated/prisma/client';
import { type Principal, isHumanPrincipal } from './principal';

// SEC-088: writes that rewrite who can do what stay ADMIN-only, whatever the matrix delegates, until #1560.
@Injectable()
export class AdminOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<Request & { principal?: Principal; user?: User }>();
    const principal: Principal | undefined =
      request.principal ??
      (request.user ? { kind: 'human', user: request.user } : undefined);
    if (isHumanPrincipal(principal) && principal.user.role === 'ADMIN') {
      return true;
    }
    throw new ForbiddenException({
      statusCode: 403,
      code: 'ADMIN_REQUIRED',
      message: 'Only an administrator can do this.',
    });
  }
}
