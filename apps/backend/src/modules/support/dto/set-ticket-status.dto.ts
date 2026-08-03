import { IsEnum } from "class-validator";
import { SupportTicketStatus } from "@prisma/client";

export class SetTicketStatusDto {
  @IsEnum(SupportTicketStatus)
  status!: SupportTicketStatus;
}
