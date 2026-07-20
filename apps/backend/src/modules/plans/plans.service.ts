import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { CreatePlanDto } from "./dto/create-plan.dto";
import { UpdatePlanDto } from "./dto/update-plan.dto";

@Injectable()
export class PlansService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.subscriptionPlan.findMany({ orderBy: { priceUsd: "asc" } });
  }

  async get(id: string) {
    const plan = await this.prisma.subscriptionPlan.findUnique({ where: { id } });
    if (!plan) {
      throw new NotFoundException("Plan not found");
    }
    return plan;
  }

  create(dto: CreatePlanDto) {
    return this.prisma.subscriptionPlan.create({
      data: {
        name: dto.name,
        dataCapBytes: BigInt(dto.dataCapBytes),
        durationDays: dto.durationDays,
        priceUsd: dto.priceUsd,
        maxConcurrentConnections: dto.maxConcurrentConnections,
        protocolsAllowed: dto.protocolsAllowed,
        isActive: dto.isActive ?? true,
      },
    });
  }

  async update(id: string, dto: UpdatePlanDto) {
    await this.get(id);
    return this.prisma.subscriptionPlan.update({
      where: { id },
      data: {
        name: dto.name,
        dataCapBytes: dto.dataCapBytes !== undefined ? BigInt(dto.dataCapBytes) : undefined,
        durationDays: dto.durationDays,
        priceUsd: dto.priceUsd,
        maxConcurrentConnections: dto.maxConcurrentConnections,
        protocolsAllowed: dto.protocolsAllowed,
        isActive: dto.isActive,
      },
    });
  }

  async remove(id: string) {
    await this.get(id);
    await this.prisma.subscriptionPlan.delete({ where: { id } });
  }
}
