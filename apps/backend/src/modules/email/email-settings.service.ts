import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { encryptCredentials, decryptCredentials } from "../protocol-users/credentials-crypto";
import { UpdateEmailSettingsDto } from "./dto/update-email-settings.dto";

export interface ResolvedEmailSettings {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  fromAddress: string;
}

@Injectable()
export class EmailSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Lazily creates the single expected row on first read -- same
   * singleton convention as FreeTrialSettings. */
  private async getRow() {
    const existing = await this.prisma.emailSettings.findFirst();
    if (existing) return existing;
    return this.prisma.emailSettings.create({ data: {} });
  }

  /** Panel/API-facing read -- never includes the password. */
  async get() {
    const { id, enabled, host, port, secure, username, fromAddress, updatedAt } = await this.getRow();
    return { id, enabled, host, port, secure, username, fromAddress, updatedAt };
  }

  async update(dto: UpdateEmailSettingsDto) {
    const row = await this.getRow();
    await this.prisma.emailSettings.update({
      where: { id: row.id },
      data: {
        enabled: dto.enabled,
        host: dto.host,
        port: dto.port,
        secure: dto.secure,
        username: dto.username,
        fromAddress: dto.fromAddress,
        ...(dto.password ? { passwordEncrypted: encryptCredentials({ password: dto.password }) } : {}),
      },
    });
    return this.get();
  }

  /** Internal, used only by EmailService to build a transporter --
   * includes the decrypted password, never exposed outside this module. */
  async resolve(): Promise<ResolvedEmailSettings | null> {
    const row = await this.getRow();
    if (!row.enabled || !row.host || !row.port || !row.username || !row.passwordEncrypted || !row.fromAddress) {
      return null;
    }
    const { password } = decryptCredentials(row.passwordEncrypted);
    return {
      enabled: row.enabled,
      host: row.host,
      port: row.port,
      secure: row.secure,
      username: row.username,
      password,
      fromAddress: row.fromAddress,
    };
  }
}
