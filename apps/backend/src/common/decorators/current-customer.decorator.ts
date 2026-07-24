import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import type { AuthenticatedCustomer } from "../../modules/customer-auth/types";

type AuthenticatedRequest = Request & { user: AuthenticatedCustomer };

export const CurrentCustomer = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedCustomer => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.user;
  },
);
