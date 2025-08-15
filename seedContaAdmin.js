// arquivo: seedContaAdmin.js
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  await prisma.contaAdmin.createMany({
    data: [
      {
        nomeTitular: "MARIA ANASTASIA ",
        banco: "BFA",
        iban: "000600009908534830137"
      },
      {
        nomeTitular: "MARIA ANASTASIA",
        banco: "BAI",
        iban: "004000009649885610118"
      },
      {
        nomeTitular: "Abençoado Adriano Mateus",
        banco: "BIC",
        iban: "005100005915076410172"
      },
      {
        nomeTitular: "MARIA ANASTASIA",
        banco: "ATL",
        iban: "005500002800024310142"
      }
    ]
  });

  console.log("Contas administrativas adicionadas com sucesso!");
}

main()
  .then(() => prisma.$disconnect())
  .catch((err) => {
    console.error(err);
    prisma.$disconnect();
  });
