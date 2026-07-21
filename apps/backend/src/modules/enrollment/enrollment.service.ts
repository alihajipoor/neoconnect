import { BadRequestException, GoneException, Injectable, NotFoundException } from "@nestjs/common";
import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { ClaimEnrollmentDto } from "./dto/claim-enrollment.dto";

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

@Injectable()
export class EnrollmentService {
  constructor(private readonly prisma: PrismaService) {}

  /** Admin-initiated: mints a one-time token the admin pastes into the
   * installer on the target VPS. The raw secret is never stored -- only
   * its hash -- so this is the only time the caller ever sees it. */
  async issueToken(nodeId: string, adminId: string) {
    const node = await this.prisma.node.findUnique({ where: { id: nodeId } });
    if (!node) {
      throw new NotFoundException("Node not found");
    }

    const secret = randomBytes(32);
    const tokenHash = createHash("sha256").update(secret).digest("hex");
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

    const row = await this.prisma.enrollmentToken.create({
      data: { nodeId, tokenHash, expiresAt, createdByAdminId: adminId },
    });

    return {
      token: `${row.id}.${secret.toString("base64url")}`,
      expiresAt,
    };
  }

  /** Agent-initiated: called once by `agentd enroll --init` over plain
   * HTTPS, before the agent has any other credential. Trades the one-time
   * token for having its freshly generated public key recorded against
   * the Node the admin created it for. */
  async claim(dto: ClaimEnrollmentDto) {
    const [tokenId, secretB64] = dto.token.split(".", 2);
    if (!tokenId || !secretB64) {
      throw new BadRequestException("Malformed enrollment token");
    }

    const row = await this.prisma.enrollmentToken.findUnique({ where: { id: tokenId } });
    if (!row) {
      throw new NotFoundException("Enrollment token not found");
    }
    if (row.status !== "PENDING") {
      throw new GoneException(`Enrollment token already ${row.status.toLowerCase()}`);
    }
    if (row.expiresAt < new Date()) {
      throw new GoneException("Enrollment token expired");
    }

    const providedHash = createHash("sha256").update(Buffer.from(secretB64, "base64url")).digest();
    const expectedHash = Buffer.from(row.tokenHash, "hex");
    if (
      providedHash.length !== expectedHash.length ||
      !timingSafeEqual(providedHash, expectedHash)
    ) {
      throw new BadRequestException("Invalid enrollment token");
    }

    if (!row.nodeId) {
      throw new BadRequestException("Enrollment token has no associated node");
    }

    await this.prisma.$transaction([
      this.prisma.enrollmentToken.update({
        where: { id: row.id },
        data: { status: "CLAIMED", claimedAt: new Date() },
      }),
      this.prisma.node.update({
        where: { id: row.nodeId },
        data: {
          agentPubKey: dto.publicKey,
          agentVersion: dto.agentVersion,
          ...(dto.publicIp ? { publicIp: dto.publicIp } : {}),
        },
      }),
    ]);

    return { nodeId: row.nodeId };
  }

  listPending() {
    return this.prisma.enrollmentToken.findMany({
      where: { status: "PENDING" },
      include: { node: { select: { id: true, name: true, role: true, region: true } } },
      orderBy: { createdAt: "desc" },
    });
  }
}
