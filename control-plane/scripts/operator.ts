// Operator account recovery from a shell (issue #10), for when nobody can
// sign in: a forgotten password, or the only operator removed by a direct
// database edit.
//
//   npm run operator -- create <email>
//   npm run operator -- reset-password <email>
//
// The password is read from CHOPPER_NEW_PASSWORD, or prompted for. Either
// way the operator must choose a new one on their next sign-in, and a reset
// signs them out everywhere. In Kubernetes, run it in the migrate image:
//   kubectl run chopper-operator --rm -it --restart=Never \
//     --image=<migrate image> --env=DATABASE_URL=... -- npm run operator -- reset-password you@example.com

import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { hashPassword, passwordProblem } from "../src/lib/password";

async function readPassword(): Promise<string> {
  const fromEnv = process.env.CHOPPER_NEW_PASSWORD;
  if (fromEnv) return fromEnv;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question("New password (input is visible): ");
  } finally {
    rl.close();
  }
}

async function main() {
  const [command, rawEmail] = process.argv.slice(2);
  const email = rawEmail?.trim().toLowerCase();
  if (!["create", "reset-password"].includes(command ?? "") || !email) {
    console.error("usage: npm run operator -- create|reset-password <email>");
    process.exit(2);
  }

  const password = await readPassword();
  const problem = passwordProblem(password);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  });
  try {
    const passwordHash = await hashPassword(password);
    if (command === "create") {
      const op = await prisma.operator.create({
        data: { email, passwordHash, mustChangePassword: true },
      });
      await prisma.auditEvent.create({
        data: { actor: "cli", action: "OPERATOR_CREATED", targetId: op.id, targetName: email },
      });
      console.log(`Created operator ${email}. They choose their own password on first sign-in.`);
    } else {
      const op = await prisma.operator.update({
        where: { email },
        data: { passwordHash, mustChangePassword: true, sessions: { deleteMany: {} } },
      });
      await prisma.auditEvent.create({
        data: {
          actor: "cli",
          action: "OPERATOR_PASSWORD_CHANGED",
          targetId: op.id,
          targetName: email,
        },
      });
      console.log(`Reset the password for ${email} and signed them out everywhere.`);
    }
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "P2002") console.error(`${email} already has an account.`);
    else if (code === "P2025") console.error(`No operator with email ${email}.`);
    else throw err;
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main();
