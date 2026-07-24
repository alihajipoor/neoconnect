import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { UpdateFreeTrialSettingsDto } from "./dto/update-free-trial-settings.dto";

@Injectable()
export class FreeTrialSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Lazily creates the single expected row on first read -- no DB-level
   * singleton constraint, just a convention this is the only caller of
   * freeTrialSettings.create(). */
  async get() {
    const existing = await this.prisma.freeTrialSettings.findFirst();
    if (existing) return existing;
    return this.prisma.freeTrialSettings.create({ data: {} });
  }

  async update(dto: UpdateFreeTrialSettingsDto) {
    const settings = await this.get();
    return this.prisma.freeTrialSettings.update({
      where: { id: settings.id },
      data: {
        enabled: dto.enabled,
        trialPlanId: dto.trialPlanId,
        trialRouteId: dto.trialRouteId,
      },
    });
  }
}
