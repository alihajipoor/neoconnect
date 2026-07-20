// Bootstraps the first SUPERADMIN account. Without this there is no way to
// log in at all, since creating an admin via the API itself requires a
// SUPERADMIN-authenticated request (see AdminsController).
//
// Usage: SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD=... pnpm --filter @neoxify/backend prisma:seed
import { PrismaClient } from "@prisma/client";
import * as argon2 from "argon2";

const prisma = new PrismaClient();

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error(
      "SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must be set, e.g.:\n" +
        "  SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD=change-me-now pnpm --filter @neoxify/backend prisma:seed",
    );
  }
  if (password.length < 8) {
    throw new Error("SEED_ADMIN_PASSWORD must be at least 8 characters");
  }

  const passwordHash = await argon2.hash(password);

  const admin = await prisma.adminUser.upsert({
    where: { email },
    update: {},
    create: { email, passwordHash, role: "SUPERADMIN" },
  });

  console.log(`Seeded SUPERADMIN: ${admin.email} (${admin.id})`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
