import { IsEnum, IsUUID } from "class-validator";
import { PaymentProvider } from "@prisma/client";

export class CreatePaymentDto {
  @IsUUID()
  subscriptionId!: string;

  @IsEnum(PaymentProvider)
  provider!: PaymentProvider;
}
