const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const rendimentos = {
  'Produto 1': 1000,
  'Produto 2': 2000,
  'Produto 3': 6000,
  'Produto 4': 16000,
  'Produto 5': 30000,
  'Produto 6': 60000,
  'Produto 7': 100000,
  'Produto 7': 160000
};

async function processarRendimentos() {
  const agora = new Date();

  try {
    const investimentos = await prisma.investimento.findMany();

    for (const inv of investimentos) {
      const rendimento = rendimentos[inv.produto];
      if (!rendimento) {
        console.log(`❌ Produto inválido: ${inv.produto}`);
        continue;
      }

      const ultima = inv.ultimoPagamento || inv.data;
      const diffHoras = (agora - new Date(ultima)) / (1000 * 60 * 60); // diferença em horas

      console.log(`⏳ Verificando ${inv.produto} de ${inv.userId}, horas passadas: ${diffHoras.toFixed(2)}`);

      if (diffHoras >= 24) {
        const userAntes = await prisma.user.findUnique({
          where: { id: inv.userId }
        });

        await prisma.user.update({
          where: { id: inv.userId },
          data: {
            saldo: { increment: rendimento }
          }
        });

        await prisma.investimento.update({
          where: { id: inv.id },
          data: {
            ultimoPagamento: agora
          }
        });

        await prisma.rendimento.create({
          data: {
            valor: rendimento,
            userId: inv.userId
          }
        });

        const userDepois = await prisma.user.findUnique({
          where: { id: inv.userId }
        });

        console.log(`💰 Rendimento de ${rendimento} adicionado ao saldo do usuário ${userDepois.telefone}`);
        console.log(`➡️ Antes: ${userAntes.saldo} | Depois: ${userDepois.saldo}`);
      } else {
        console.log(`⏱️ Ainda não passou 24h para ${inv.userId}`);
      }
    }

  } catch (err) {
    console.error('❌ Erro ao processar rendimentos:', err);
  }
}

module.exports = { processarRendimentos };
