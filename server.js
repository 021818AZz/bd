const express = require('express');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const cors = require('cors');
const cron = require('node-cron');
const { processarRendimentos } = require('./rendimento-diario');

const app = express();
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

const JWT_SECRET = 'seu_segredo_super_seguro';

// Gerar código de convite
function gerarCodigoConvite() {
    const random = crypto.randomBytes(4).toString('hex').toUpperCase();
    return `INV-${random}`;
}

// Gerar token JWT
function gerarToken(id) {
    return jwt.sign({ id }, JWT_SECRET, { expiresIn: '7d' });
}

// Middleware para proteger rotas
function autenticarToken(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ mensagem: "Token não fornecido" });
    }

    const token = authHeader.split(' ')[1];
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        req.usuarioId = payload.id;
        next();
    } catch {
        return res.status(401).json({ mensagem: "Token inválido ou expirado" });
    }
}

// ================== ROTAS PÚBLICAS ================== //
// Obter subordinados em 3 níveis de profundidade
// Rota para obter os dados da equipe
// Rota para obter os dados da equipe
app.get('/api/minha-equipe', autenticarToken, async (req, res) => {
  try {
    const userId = req.usuarioId;

    // Buscar informações do usuário atual
    const usuario = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        codigoConvite: true
      }
    });

    if (!usuario) {
      return res.status(404).json({ mensagem: "Usuário não encontrado" });
    }

    // Buscar todos os usuários indicados diretamente (nível A)
    const nivelA = await prisma.user.findMany({
      where: { 
        referenciadoPor: userId 
      },
      select: {
        id: true,
        telefone: true,
        criadoEm: true,
        codigoConvite: true
      }
    });

    // Buscar usuários de nível B (indicados pelos indicados diretos)
    const idsNivelA = nivelA.map(u => u.id);
    const nivelB = await prisma.user.findMany({
      where: {
        referenciadoPor: { in: idsNivelA }
      },
      select: {
        id: true,
        telefone: true,
        criadoEm: true,
        codigoConvite: true
      }
    });

    // Buscar usuários de nível C (indicados pelos usuários de nível B)
    const idsNivelB = nivelB.map(u => u.id);
    const nivelC = await prisma.user.findMany({
      where: {
        referenciadoPor: { in: idsNivelB }
      },
      select: {
        id: true,
        telefone: true,
        criadoEm: true,
        codigoConvite: true
      }
    });

    // Função para verificar investimentos e calcular comissões
    const calcularComissoes = async (usuarios, nivel) => {
      const usuariosComInvestimentos = [];
      let totalComissoes = 0;
      
      for (const usuario of usuarios) {
        const investimentos = await prisma.investimento.findMany({
          where: { userId: usuario.id }
        });
        
        if (investimentos.length > 0) {
          usuariosComInvestimentos.push(usuario);
          
          // Calcular comissão para cada investimento
          for (const investimento of investimentos) {
            let porcentagem = 0;
            switch(nivel) {
              case 'A': porcentagem = 0.30; break;
              case 'B': porcentagem = 0.06; break;
              case 'C': porcentagem = 0.01; break;
            }
            totalComissoes += investimento.valor * porcentagem;
          }
        }
      }
      
      return {
        usuariosValidos: usuariosComInvestimentos,
        totalComissoes
      };
    };

    // Calcular para cada nível
    const nivelADados = await calcularComissoes(nivelA, 'A');
    const nivelBDados = await calcularComissoes(nivelB, 'B');
    const nivelCDados = await calcularComissoes(nivelC, 'C');

    // Calcular totais
    const totalIndicados = nivelA.length + nivelB.length + nivelC.length;
    const indicadosValidos = nivelADados.usuariosValidos.length + nivelBDados.usuariosValidos.length + nivelCDados.usuariosValidos.length;
    
    // Calcular comissões totais recebidas
    const comissoes = await prisma.comissao.aggregate({
      where: { userId },
      _sum: { valor: true }
    });

    res.json({
      codigoConvite: usuario.codigoConvite,
      totalIndicados,
      indicadosValidos,
      descontoTotal: comissoes._sum.valor?.toFixed(2) || '0.00',
      nivelA: {
        quantidade: nivelA.length,
        quantidadeValidos: nivelADados.usuariosValidos.length,
        valor: nivelADados.totalComissoes.toFixed(2),
        usuarios: nivelA,
        usuariosValidos: nivelADados.usuariosValidos
      },
      nivelB: {
        quantidade: nivelB.length,
        quantidadeValidos: nivelBDados.usuariosValidos.length,
        valor: nivelBDados.totalComissoes.toFixed(2),
        usuarios: nivelB,
        usuariosValidos: nivelBDados.usuariosValidos
      },
      nivelC: {
        quantidade: nivelC.length,
        quantidadeValidos: nivelCDados.usuariosValidos.length,
        valor: nivelCDados.totalComissoes.toFixed(2),
        usuarios: nivelC,
        usuariosValidos: nivelCDados.usuariosValidos
      },
      comissoesTotais: comissoes._sum.valor || 0
    });

  } catch (error) {
    console.error("Erro ao buscar equipe:", error);
    res.status(500).json({ mensagem: "Erro ao buscar dados da equipe", erro: error.message });
  }
});
// Criar usuário
app.post('/usuarios', async (req, res) => {
    const { telefone, senha, codigoConvite } = req.body;
    
    if (!telefone || !senha) {
        return res.status(400).json({ mensagem: "Telefone e senha são obrigatórios!" });
    }

    // Validar formato do telefone (+244 seguido de 9 dígitos)
    if (!telefone.match(/^\+244\d{9}$/)) {
        return res.status(400).json({ mensagem: "Formato de telefone inválido. Deve ser +244 seguido de 9 dígitos" });
    }

    try {
        // Verificar se o telefone já está cadastrado
        const usuarioExistente = await prisma.user.findUnique({
            where: { telefone }
        });

        if (usuarioExistente) {
            return res.status(400).json({ mensagem: "Este telefone já está cadastrado!" });
        }

        const senhaHash = await bcrypt.hash(senha, 10);
        const codigoConviteUsuario = gerarCodigoConvite();

        // Verificar código de convite
        let referenciadoPor = null;
        if (codigoConvite) {
            const usuarioReferenciador = await prisma.user.findFirst({
                where: { codigoConvite }
            });

            if (!usuarioReferenciador) {
                return res.status(400).json({ mensagem: "Código de convite inválido!" });
            }
            referenciadoPor = usuarioReferenciador.id;
        }

        const novoUsuario = await prisma.user.create({
            data: {
                telefone,
                senha: senhaHash,
                codigoConvite: codigoConviteUsuario,
                saldo: 1800,
                referenciadoPor: referenciadoPor
            }
        });

        if (referenciadoPor) {
            await prisma.user.update({
                where: { id: referenciadoPor },
                data: { saldo: { increment: 500 } }
            });

            await prisma.indicacao.create({
                data: {
                    indicadorId: referenciadoPor,
                    indicadoId: novoUsuario.id,
                    codigoConvite: codigoConvite
                }
            });
        }

        const token = gerarToken(novoUsuario.id);

        res.status(201).json({
            mensagem: "Usuário criado com sucesso!",
            usuario: {
                id: novoUsuario.id,
                telefone: novoUsuario.telefone,
                codigoConvite: novoUsuario.codigoConvite,
                saldo: novoUsuario.saldo
            },
            token
        });
    } catch (error) {
        console.error("Erro ao criar usuário:", error);
        res.status(400).json({
            mensagem: "Erro ao criar usuário!",
            erro: error.message
        });
    }
});
// Login
app.post('/login', async (req, res) => {
    const { telefone, senha } = req.body;

    try {
        const usuario = await prisma.user.findUnique({ where: { telefone } });

        if (!usuario) {
            return res.status(404).json({ mensagem: "Usuário não encontrado!" });
        }

        const senhaCorreta = await bcrypt.compare(senha, usuario.senha);
        if (!senhaCorreta) {
            return res.status(401).json({ mensagem: "Senha incorreta!" });
        }

        const token = gerarToken(usuario.id);

        res.status(200).json({
            mensagem: "Login bem-sucedido!",
            usuario: {
                id: usuario.id,
                telefone: usuario.telefone,
                codigoConvite: usuario.codigoConvite,
                saldo: usuario.saldo
            },
            token
        });
    } catch (error) {
        res.status(500).json({ mensagem: "Erro ao fazer login", erro: error.message });
    }
});

// ================== ROTAS PROTEGIDAS ================== //
app.use(autenticarToken);

// Dados do usuário
app.get('/me', async (req, res) => {
    try {
        const usuario = await prisma.user.findUnique({
            where: { id: req.usuarioId },
            select: {
                id: true,
                telefone: true,
                codigoConvite: true,
                saldo: true,
                criadoEm: true,
                referenciadoPor: true
            }
        });

        if (!usuario) {
            return res.status(404).json({ mensagem: "Usuário não encontrado!" });
        }

        const hoje = new Date();
        hoje.setHours(0, 0, 0, 0);

        // Receita de hoje
        const receitaDeHoje = await prisma.rendimento.aggregate({
            where: {
                userId: req.usuarioId,
                data: { gte: hoje }
            },
            _sum: { valor: true }
        });

        // Rendimento total
        const rendimentoTotal = await prisma.rendimento.aggregate({
            where: { userId: req.usuarioId },
            _sum: { valor: true }
        });

        // Indicações do usuário
        const indicacoes = await prisma.indicacao.findMany({
            where: { indicadorId: req.usuarioId },
            include: { indicado: true },
            orderBy: { dataIndicacao: 'desc' }
        });

        // Comissões recebidas por nível
        const comissoesA = await prisma.comissao.findMany({
            where: { 
                userId: req.usuarioId,
                nivel: 'A'
            },
            orderBy: { createdAt: 'desc' }
        });

        const comissoesB = await prisma.comissao.findMany({
            where: { 
                userId: req.usuarioId,
                nivel: 'B'
            },
            orderBy: { createdAt: 'desc' }
        });

        const comissoesC = await prisma.comissao.findMany({
            where: { 
                userId: req.usuarioId,
                nivel: 'C'
            },
            orderBy: { createdAt: 'desc' }
        });

        res.json({
            usuario: {
                ...usuario,
                receitaDeHoje: receitaDeHoje._sum.valor || 0,
                rendimentoTotal: rendimentoTotal._sum.valor || 0,
                totalIndicacoes: indicacoes.length,
                indicacoes: indicacoes.map(i => ({
                    id: i.indicado.id,
                    telefone: i.indicado.telefone,
                    dataIndicacao: i.dataIndicacao
                })),
                comissoes: {
                    nivelA: comissoesA.map(c => ({
                        valor: c.valor,
                        investimentoId: c.investimentoId,
                        valorInvestimento: c.valorInvestimento,
                        data: c.createdAt
                    })),
                    nivelB: comissoesB.map(c => ({
                        valor: c.valor,
                        investimentoId: c.investimentoId,
                        valorInvestimento: c.valorInvestimento,
                        data: c.createdAt
                    })),
                    nivelC: comissoesC.map(c => ({
                        valor: c.valor,
                        investimentoId: c.investimentoId,
                        valorInvestimento: c.valorInvestimento,
                        data: c.createdAt
                    }))
                }
            }
        });
    } catch (err) {
        console.error("Erro em /me:", err);
        res.status(500).json({ mensagem: "Erro interno", erro: err.message });
    }
});
// Conta bancária - Adicionar/Atualizar
app.post('/iban', async (req, res) => {
    const { bank, account_number, account_holder } = req.body;
    
    if (!bank || !account_number || !account_holder) {
        return res.status(400).json({ 
            success: false,
            message: "Banco, número da conta e nome do titular são obrigatórios" 
        });
    }

    const bancosValidos = ['BFA', 'BAI', 'BIC', 'ATL'];
    if (!bancosValidos.includes(bank)) {
        return res.status(400).json({ 
            success: false,
            message: "Banco inválido. Escolha entre BFA, BAI, BIC ou ATL" 
        });
    }

    if (!/^\d{21}$/.test(account_number)) {
        return res.status(400).json({ 
            success: false,
            message: "Número da conta deve conter exatamente 21 dígitos" 
        });
    }

    try {
        const contaExistente = await prisma.bankAccount.findFirst({
            where: { userId: req.usuarioId }
        });

        if (contaExistente) {
            const contaAtualizada = await prisma.bankAccount.update({
                where: { id: contaExistente.id },
                data: {
                    bank,
                    account_number,
                    account_holder,
                    updated_at: new Date()
                }
            });

            return res.json({
                success: true,
                message: "Conta bancária atualizada com sucesso",
                account: contaAtualizada
            });
        } else {
            const novaConta = await prisma.bankAccount.create({
                data: {
                    bank,
                    account_number,
                    account_holder,
                    userId: req.usuarioId
                }
            });

            return res.json({
                success: true,
                message: "Conta bancária cadastrada com sucesso",
                account: novaConta
            });
        }
    } catch (error) {
        console.error("Erro ao cadastrar conta bancária:", error);
        return res.status(500).json({ 
            success: false,
            message: "Erro ao cadastrar conta bancária",
            error: error.message 
        });
    }
});

// Obter conta bancária
app.get('/iban', async (req, res) => {
    try {
        const conta = await prisma.bankAccount.findFirst({
            where: { userId: req.usuarioId },
            select: {
                id: true,
                bank: true,
                account_number: true,
                account_holder: true,
                created_at: true,
                updated_at: true
            }
        });

        if (!conta) {
            return res.status(404).json({ 
                success: false,
                message: "Nenhuma conta bancária cadastrada" 
            });
        }

        return res.json({ success: true, account: conta });
    } catch (error) {
        console.error("Erro ao buscar conta bancária:", error);
        return res.status(500).json({ 
            success: false,
            message: "Erro ao buscar conta bancária",
            error: error.message 
        });
    }
});

// ================== SISTEMA DE SAQUES ================== //

// Criar solicitação de saque
app.post('/withdrawals', async (req, res) => {
    const { bank_account_id, amount } = req.body;
    
    // Validações básicas
    if (!bank_account_id || !amount) {
        return res.status(400).json({ 
            success: false,
            message: "Conta bancária e valor são obrigatórios" 
        });
    }
    
    if (amount < 1200) {
        return res.status(400).json({ 
            success: false,
            message: "O valor mínimo para saque é KZ1,200.00" 
        });
    }
    
    if (amount > 100000) {
        return res.status(400).json({ 
            success: false,
            message: "O valor máximo para saque é KZ100,000.00" 
        });
    }
    
    try {
        // Verificar se é dia permitido (segunda a sábado)
        const hoje = new Date();
        const diaSemana = hoje.getDay(); // 0=Domingo, 1=Segunda, ..., 6=Sábado
        
        if (diaSemana === 0) { // Domingo
            return res.status(400).json({ 
                success: false,
                message: "Saques não são processados aos domingos" 
            });
        }

        // Verificar conta bancária
        const bankAccount = await prisma.bankAccount.findFirst({
            where: {
                id: bank_account_id,
                userId: req.usuarioId
            }
        });
        
        if (!bankAccount) {
            return res.status(404).json({ 
                success: false,
                message: "Conta bancária não encontrada" 
            });
        }
        
        // Verificar saldo
        const user = await prisma.user.findUnique({
            where: { id: req.usuarioId },
            select: { saldo: true }
        });
        
        if (user.saldo < amount) {
            return res.status(400).json({ 
                success: false,
                message: "Saldo insuficiente para este saque" 
            });
        }
        
        // Calcular taxa (10%) e valor líquido
        const fee = amount * 0.1;
        const net_amount = amount - fee;
        
        // Criar retirada
        const withdrawal = await prisma.withdrawal.create({
            data: {
                amount,
                fee,
                net_amount,
                status: "pending",
                bank_account_id,
                user_id: req.usuarioId
            }
        });
        
        // Atualizar saldo do usuário
        await prisma.user.update({
            where: { id: req.usuarioId },
            data: { saldo: { decrement: amount } }
        });
        
        res.json({
            success: true,
            message: "Saque solicitado com sucesso",
            withdrawal
        });
        
    } catch (error) {
        console.error("Erro ao criar retirada:", error);
        res.status(500).json({ 
            success: false,
            message: "Erro ao solicitar saque",
            error: error.message 
        });
    }
});

// Listar retiradas do usuário
app.get('/withdrawals', async (req, res) => {
    try {
        const withdrawals = await prisma.withdrawal.findMany({
            where: { user_id: req.usuarioId },
            include: { bank_account: true },
            orderBy: { created_at: 'desc' }
        });
        
        res.json({ success: true, withdrawals });
    } catch (error) {
        console.error("Erro ao buscar retiradas:", error);
        res.status(500).json({ 
            success: false,
            message: "Erro ao buscar retiradas",
            error: error.message 
        });
    }
});

// ================== SISTEMA DE INDICAÇÕES ================== //

// Obter informações sobre indicações
app.get('/indicacoes', async (req, res) => {
    try {
        // Total de indicações
        const totalIndicacoes = await prisma.indicacao.count({
            where: { indicadorId: req.usuarioId }
        });

        // Indicações recentes (últimas 5)
        const indicacoesRecentes = await prisma.indicacao.findMany({
            where: { indicadorId: req.usuarioId },
            include: { indicado: true },
            orderBy: { dataIndicacao: 'desc' },
            take: 5
        });

        // Total de bônus recebidos por indicações
        const bonusIndicacoes = totalIndicacoes * 500; // 500 por indicação

        res.json({
            success: true,
            totalIndicacoes,
            bonusIndicacoes,
            indicacoesRecentes: indicacoesRecentes.map(i => ({
                id: i.indicado.id,
                telefone: i.indicado.telefone,
                dataIndicacao: i.dataIndicacao,
                codigoConviteUtilizado: i.codigoConviteUtilizado
            }))
        });
    } catch (error) {
        console.error("Erro ao buscar indicações:", error);
        res.status(500).json({ 
            success: false,
            message: "Erro ao buscar informações de indicações",
            error: error.message 
        });
    }
});

// ================== OUTRAS ROTAS ================== //

// Atualizar saldo
app.post('/atualizar-saldo', async (req, res) => {
    const { valor } = req.body;
    
    try {
        const usuario = await prisma.user.update({
            where: { id: req.usuarioId },
            data: { saldo: { increment: valor } }
        });
        
        res.json({ success: true, novoSaldo: usuario.saldo });
    } catch (error) {
        res.status(400).json({ 
            success: false,
            message: "Erro ao atualizar saldo",
            error: error.message
        });
    }
});

// Registrar investimento
// Registrar investimento
app.post('/investir', async (req, res) => {
    const { produto, valor, data } = req.body;
    
    try {
        const usuario = await prisma.user.findUnique({
            where: { id: req.usuarioId },
            select: { saldo: true, referenciadoPor: true }
        });

        if (usuario.saldo < valor) {
            return res.status(400).json({
                success: false,
                message: "Saldo insuficiente para este investimento"
            });
        }

        // Atualizar saldo do usuário
        await prisma.user.update({
            where: { id: req.usuarioId },
            data: { saldo: { decrement: valor } }
        });

        // Registrar o investimento
        const investimento = await prisma.investimento.create({
            data: {
                produto,
                valor,
                data: new Date(data),
                userId: req.usuarioId,
                ultimoPagamento: new Date(data)
            }
        });

        // Distribuir bônus para os níveis A, B e C
        await distribuirBonus(req.usuarioId, valor);

        res.json({ 
            success: true,
            investimento,
            message: "Investimento realizado com sucesso!"
        });
    } catch (error) {
        res.status(400).json({ 
            success: false,
            message: "Erro ao registrar investimento",
            error: error.message
        });
    }
});

// Função para distribuir bônus nos 3 níveis
async function distribuirBonus(userId, valorInvestimento) {
    try {
        // Encontrar o usuário atual
        const usuarioAtual = await prisma.user.findUnique({
            where: { id: userId },
            select: { referenciadoPor: true }
        });

        if (!usuarioAtual || !usuarioAtual.referenciadoPor) {
            return; // Não há referenciador, não distribui bônus
        }

        // Nível A (indicador direto)
        const nivelA = await prisma.user.findUnique({
            where: { id: usuarioAtual.referenciadoPor }
        });

        if (nivelA) {
            const bonusA = valorInvestimento * 0.30; // 30%
            await prisma.user.update({
                where: { id: nivelA.id },
                data: { 
                    saldo: { increment: bonusA } 
                }
            });

            // Registrar a comissão
            await prisma.comissao.create({
                data: {
                    userId: nivelA.id,
                    valor: bonusA,
                    nivel: 'A',
                    investimentoId: userId,
                    valorInvestimento: valorInvestimento
                }
            });
        }

        // Nível B (indicador do indicador)
        if (nivelA && nivelA.referenciadoPor) {
            const nivelB = await prisma.user.findUnique({
                where: { id: nivelA.referenciadoPor }
            });

            if (nivelB) {
                const bonusB = valorInvestimento * 0.06; // 6%
                await prisma.user.update({
                    where: { id: nivelB.id },
                    data: { 
                        saldo: { increment: bonusB } 
                    }
                });

                // Registrar a comissão
                await prisma.comissao.create({
                    data: {
                        userId: nivelB.id,
                        valor: bonusB,
                        nivel: 'B',
                        investimentoId: userId,
                        valorInvestimento: valorInvestimento
                    }
                });
            }
        }

        // Nível C (indicador do indicador do indicador)
        if (nivelA && nivelA.referenciadoPor) {
            const nivelB = await prisma.user.findUnique({
                where: { id: nivelA.referenciadoPor }
            });

            if (nivelB && nivelB.referenciadoPor) {
                const nivelC = await prisma.user.findUnique({
                    where: { id: nivelB.referenciadoPor }
                });

                if (nivelC) {
                    const bonusC = valorInvestimento * 0.01; // 1%
                    await prisma.user.update({
                        where: { id: nivelC.id },
                        data: { 
                            saldo: { increment: bonusC } 
                        }
                    });

                    // Registrar a comissão
                    await prisma.comissao.create({
                        data: {
                            userId: nivelC.id,
                            valor: bonusC,
                            nivel: 'C',
                            investimentoId: userId,
                            valorInvestimento: valorInvestimento
                        }
                    });
                }
            }
        }
    } catch (error) {
        console.error("Erro ao distribuir bônus:", error);
    }
}
// Rota para criar depósito
app.post('/deposits', autenticarToken, async (req, res) => {
  try {
    const { amount, bank, comprovante, fileName, fileType } = req.body;

    // Validações
    if (!amount || !bank || !comprovante || !fileName || !fileType) {
      return res.status(400).json({
        success: false,
        message: "Todos os campos são obrigatórios"
      });
    }

    if (amount < 3500) {
      return res.status(400).json({
        success: false,
        message: "O valor mínimo para depósito é KZ 3.500"
      });
    }

    if (!['BAI', 'BFA', 'BIC', 'ATL'].includes(bank)) {
      return res.status(400).json({
        success: false,
        message: "Banco inválido. Escolha entre BAI, BFA, BIC ou ATL"
      });
    }

    // Criar o depósito
    const deposit = await prisma.deposit.create({
      data: {
        amount,
        bank,
        comprovante,
        fileName,
        fileType,
        userId: req.usuarioId
      }
    });

    res.json({
      success: true,
      message: "Depósito registrado com sucesso. Aguarde confirmação.",
      deposit
    });

  } catch (error) {
    console.error("Erro ao processar depósito:", error);
    res.status(500).json({
      success: false,
      message: "Erro ao processar depósito",
      error: error.message
    });
  }
});

// Rota para listar depósitos do usuário
app.get('/deposits', autenticarToken, async (req, res) => {
  try {
    const deposits = await prisma.deposit.findMany({
      where: { userId: req.usuarioId },
      orderBy: { createdAt: 'desc' }
    });

    res.json({
      success: true,
      deposits
    });

  } catch (error) {
    console.error("Erro ao buscar depósitos:", error);
    res.status(500).json({
      success: false,
      message: "Erro ao buscar depósitos",
      error: error.message
    });
  }
});
// Rota para trocar senha
app.post('/change-password', autenticarToken, async (req, res) => {
    const { currentPassword, newPassword } = req.body;

    try {
        // Buscar usuário
        const user = await prisma.user.findUnique({
            where: { id: req.usuarioId }
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "Usuário não encontrado"
            });
        }

        // Verificar senha atual
        const isPasswordValid = await bcrypt.compare(currentPassword, user.senha);
        if (!isPasswordValid) {
            return res.status(401).json({
                success: false,
                message: "Senha atual incorreta"
            });
        }

        // Validar nova senha
        if (newPassword.length < 6) {
            return res.status(400).json({
                success: false,
                message: "A senha deve ter pelo menos 6 caracteres"
            });
        }

        // Criptografar nova senha
        const hashedPassword = await bcrypt.hash(newPassword, 10);

        // Atualizar senha
        await prisma.user.update({
            where: { id: req.usuarioId },
            data: { senha: hashedPassword }
        });

        res.json({
            success: true,
            message: "Senha alterada com sucesso"
        });

    } catch (error) {
        console.error("Erro ao alterar senha:", error);
        res.status(500).json({
            success: false,
            message: "Erro ao alterar senha",
            error: error.message
        });
    }
});

// Listar investimentos
app.get('/meus-investimentos', async (req, res) => {
    try {
        const investimentos = await prisma.investimento.findMany({
            where: { userId: req.usuarioId },
            orderBy: { data: 'desc' }
        });

        res.json({ success: true, investimentos });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Erro ao buscar investimentos",
            error: error.message
        });
    }
});

// Rota de teste
app.get('/', (req, res) => {
    res.send('🛡️ Servidor protegido está online!');
});

// CRON JOB para processar rendimentos
cron.schedule('* * * * *', () => {
    console.log('⏰ Executando rendimento automático...');
    processarRendimentos();
});

// Iniciar servidor
const PORT = process.env.PORT || 3333;
app.listen(PORT, () => {
    console.log(`✅ Servidor rodando em http://localhost:${PORT}`);
});