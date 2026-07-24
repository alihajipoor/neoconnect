import { IsUUID } from "class-validator";

// Deliberately just {planId} -- unlike the admin CreateSubscriptionDto,
// customerId is never taken from the request body, only from the
// authenticated customer's own JWT (see customer.controller.ts).
export class CreateOwnSubscriptionDto {
  @IsUUID()
  planId!: string;
}
