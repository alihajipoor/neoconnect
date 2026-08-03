import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { UpdateReferralSettingsDto } from "./dto/update-referral-settings.dto";

@Injectable()
export class ReferralSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Lazily creates the single expected row on first read -- same
   * convention as FreeTrialSettings, no DB-level singleton constraint. */
  async get() {
    const existing = await this.prisma.referralSettings.findFirst();
    if (existing) return existing;
    return this.prisma.referralSettings.create({ data: {} });
  }

  async update(dto: UpdateReferralSettingsDto) {
    const settings = await this.get();
    return this.prisma.referralSettings.update({
      where: { id: settings.id },
      data: {
        enabled: dto.enabled,
        rewardPlanId: dto.rewardPlanId,
        loyalFriendMonths: dto.loyalFriendMonths,
        friendsRequired: dto.friendsRequired,
        friendMonths: dto.friendMonths,
        rewardDays: dto.rewardDays,
      },
    });
  }
}
