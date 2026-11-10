import { Module } from "@nestjs/common";
import { DoorProber } from "./door-prober";
import { NodeDoorsService } from "./node-doors.service";

/** Each node as a door to the panel API (door.ts). Pulls in Prisma only,
 * which is global, so the nodes module and the scheduled jobs can both
 * import it without a cycle. */
@Module({
  providers: [NodeDoorsService, DoorProber],
  exports: [NodeDoorsService],
})
export class NodeDoorsModule {}
