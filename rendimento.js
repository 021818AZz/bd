// rendimento.js
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function calcularRendimentosDiarios() {
    try {
        console.log('🔄 Iniciando cálculo de rendimentos diários...');
        
        // Busca investimentos ativos (não expirados e com mais de 24h desde último pagamento)
        const investimentosAtivos = await prisma.investimento.findMany({
            where: {
                AND: [
                    { dataExpiracao: { gt: new Date() } }, // Não expirado
                    { 
                        OR: [
                            { ultimoPagamento: null }, // Nunca foi pago
                            { 
                                ultimoPagamento: { 
                                    lt: new Date(new Date().getTime() - 24 * 60 * 60 * 1000) // Mais de 24h
                                } 
                            }
                        ]
                    }
                ]
            },
            include: { usuario: true }
        });

        console.log(`📊 Investimentos elegíveis para rendimento: ${investimentosAtivos.length}`);
        
        // Processa cada investimento
        for (const investimento of investimentosAtivos) {
            const agora = new Date();
            const ultimoPagamento = investimento.ultimoPagamento || investimento.dataCompra;
            const horasDesdeUltimoPagamento = (agora - ultimoPagamento) / (1000 * 60 * 60);

            // Calcula dias completos desde último pagamento
            const diasCompletos = Math.floor(horasDesdeUltimoPagamento / 24);
            const rendimentoTotal = investimento.rendaDiaria * diasCompletos;

            console.log(`💼 Processando: ${investimento.nome} | Dias: ${diasCompletos} | Rendimento: KZ ${rendimentoTotal}`);
            
            // Atualiza saldo do usuário
            await prisma.usuario.update({
                where: { id: investimento.usuarioId },
                data: { saldo: { increment: rendimentoTotal } }
            });

            // Registra no histórico
            await prisma.historico.create({
                data: {
                    usuarioId: investimento.usuarioId,
                    valor: rendimentoTotal,
                    descricao: `Rendimento de ${diasCompletos} dias (${investimento.nome})`,
                    tipo: 'RENDIMENTO'
                }
            });

            // Atualiza data do último pagamento
            await prisma.investimento.update({
                where: { id: investimento.id },
                data: { 
                    ultimoPagamento: new Date(ultimoPagamento.getTime() + diasCompletos * 24 * 60 * 60 * 1000)
                }
            });
        }

        console.log('✅ Cálculo de rendimentos concluído');
    } catch (error) {
        console.error('❌ Erro ao calcular rendimentos:', error);
    }
}

function iniciarCronRendimentos() {
    console.log('⏰ Agendador de rendimentos ativado (verificação a cada hora)');
    
    // Executa imediatamente ao iniciar
    calcularRendimentosDiarios();
    
    // Agenda para executar a cada hora (verifica se há rendimentos a pagar)
    setInterval(calcularRendimentosDiarios, 60 * 60 * 1000); // 1 hora
}

module.exports = {
    calcularRendimentosDiarios,
    iniciarCronRendimentos
};