import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { EnrollmentService } from "./enrollment.service";
import { ClaimEnrollmentDto } from "./dto/claim-enrollment.dto";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";

@ApiTags("enrollment")
@Controller("enrollment")
export class EnrollmentController {
  constructor(private readonly enrollmentService: EnrollmentService) {}

  // Intentionally unauthenticated: the agent has no admin credentials at
  // this point, only the one-time token an admin issued and pasted into
  // the installer. Knowledge of that token IS the authentication for this
  // single call -- the same pattern as Kubernetes bootstrap tokens or
  // Docker Swarm join tokens. The token itself is a random 32-byte
  // secret (see enrollment.service.ts), so brute-forcing it isn't
  // realistically feasible either way -- this limit is defense-in-depth,
  // not the actual protection.
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("claim")
  @HttpCode(HttpStatus.OK)
  claim(@Body() dto: ClaimEnrollmentDto) {
    return this.enrollmentService.claim(dto);
  }

  @Get("pending")
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  listPending() {
    return this.enrollmentService.listPending();
  }
}
