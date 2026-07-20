import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import * as argon2 from "argon2";
import { PrismaService } from "../../prisma/prisma.service";
import { CreateAdminDto } from "./dto/create-admin.dto";
import { UpdateAdminDto } from "./dto/update-admin.dto";

const SAFE_SELECT = {
  id: true,
  email: true,
  role: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class AdminsService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.adminUser.findMany({ select: SAFE_SELECT, orderBy: { createdAt: "asc" } });
  }

  async get(id: string) {
    const admin = await this.prisma.adminUser.findUnique({ where: { id }, select: SAFE_SELECT });
    if (!admin) {
      throw new NotFoundException("Admin not found");
    }
    return admin;
  }

  async create(dto: CreateAdminDto) {
    const existing = await this.prisma.adminUser.findUnique({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException("An admin with this email already exists");
    }
    const passwordHash = await argon2.hash(dto.password);
    return this.prisma.adminUser.create({
      data: { email: dto.email, passwordHash, role: dto.role },
      select: SAFE_SELECT,
    });
  }

  async update(id: string, dto: UpdateAdminDto) {
    await this.get(id);
    const data: { passwordHash?: string; role?: UpdateAdminDto["role"]; tokenVersion?: { increment: number } } = {};
    if (dto.password) {
      data.passwordHash = await argon2.hash(dto.password);
      // Rotate refresh tokens whenever the password changes.
      data.tokenVersion = { increment: 1 };
    }
    if (dto.role) {
      data.role = dto.role;
    }
    return this.prisma.adminUser.update({ where: { id }, data, select: SAFE_SELECT });
  }

  async remove(id: string) {
    await this.get(id);
    await this.prisma.adminUser.delete({ where: { id } });
  }
}
