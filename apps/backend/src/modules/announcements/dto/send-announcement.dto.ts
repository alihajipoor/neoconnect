import { SubscriptionStatus } from "@prisma/client";
import { IsArray, IsEnum, IsOptional, IsString, IsUUID, MinLength } from "class-validator";

// Filters are combinable (AND'd together), not mutually exclusive -- e.g.
// {statuses: ["ACTIVE"], routeIds: [...]} targets active subscribers on a
// specific server, for a "maintenance on the Germany server" notice. No
// filters at all targets every subscription regardless of status --
// a genuine "send to everyone who's ever subscribed" broadcast.
export class SendAnnouncementDto {
  @IsString()
  @MinLength(1)
  subject!: string;

  @IsString()
  @MinLength(1)
  body!: string;

  @IsOptional()
  @IsArray()
  @IsEnum(SubscriptionStatus, { each: true })
  statuses?: SubscriptionStatus[];

  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  planIds?: string[];

  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  routeIds?: string[];
}
