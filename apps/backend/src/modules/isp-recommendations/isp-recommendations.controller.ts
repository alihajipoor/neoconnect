import { Controller, Get, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { AsnLookupService } from "../network-identity/asn-lookup.service";
import { IspRecommendationsService } from "./isp-recommendations.service";

@ApiTags("isp-recommendations")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller("isp-recommendations")
export class IspRecommendationsController {
  constructor(
    private readonly recommendations: IspRecommendationsService,
    private readonly asn: AsnLookupService,
  ) {}

  /** Per network, per route: who tried, who got through, who stayed up,
   * and the tag a customer on that network is being shown. Any admin may
   * read it, like /client-attempts and /reachability -- it is the same
   * diagnosis from a third angle, and it holds counts, not people.
   *
   * Carries the table's own status, because "no networks" means two
   * very different things depending on whether the ASN table loaded. */
  @Get()
  async summary() {
    return { ...(await this.recommendations.adminSummary()), dataset: this.asn.status() };
  }
}
