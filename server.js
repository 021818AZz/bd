const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const NodeCache = require('node-cache');

const prisma = new PrismaClient();
const app = express();
const PORT = 3333;
const cache = new NodeCache({ stdTTL: 300, checkperiod: 120 });

// Configurações básicas
app.use(cors());
app.use(express.json());

// Middleware de autenticação JWT
const authenticateJWT = (req, res, next) => {
    const authHeader = req.headers.authorization;
    
    if (authHeader) {
        const token = authHeader.split(' ')[1];
        
        jwt.verify(token, 'SEGREDO_SUPER_SECRETO', (err, user) => {
            if (err) {
                return res.sendStatus(403);
            }
            
            req.user = user;
            next();
        });
    } else {
        res.sendStatus(401);
    }
};

// Função para invalidar cache do usuário
const invalidateUserCache = (userId) => {
    cache.del(`user_${userId}_data`);
    cache.del(`team_${userId}_data`);
};

// Rota para dados do usuário (com cache)
app.get('/me', authenticateJWT, async (req, res) => {
    try {
        const userId = req.user.id;
        const cacheKey = `user_${userId}_data`;

        // Verificar cache
        const cachedData = cache.get(cacheKey);
        if (cachedData) {
            return res.json({
                success: true,
                ...cachedData,
                cached: true
            });
        }

        // Buscar dados em paralelo
        const [user, withdrawals, deposits, bankAccounts, investments, earnings, referrals, commissions] = await Promise.all([
            prisma.user.findUnique({
                where: { id: userId },
                select: {
                    id: true,
                    telefone: true,
                    codigoConvite: true,
                    saldo: true,
                    criadoEm: true
                }
            }),
            prisma.withdrawal.findMany({
                where: { user_id: userId },
                select: {
                    id: true,
                    amount: true,
                    status: true,
                    created_at: true
                },
                take: 20
            }),
            prisma.deposit.findMany({
                where: { userId },
                select: {
                    id: true,
                    amount: true,
                    status: true,
                    createdAt: true
                },
                take: 20
            }),
            prisma.bankAccount.findMany({
                where: { userId },
                select: {
                    id: true,
                    bank: true,
                    account_number: true
                }
            }),
            prisma.investimento.findMany({
                where: { userId },
                select: {
                    id: true,
                    produto: true,
                    valor: true,
                    data: true
                },
                take: 10
            }),
            prisma.rendimento.findMany({
                where: { userId },
                select: {
                    id: true,
                    valor: true,
                    data: true
                },
                take: 20
            }),
            prisma.indicacao.findMany({
                where: { indicadorId: userId },
                select: {
                    dataIndicacao: true,
                    indicado: {
                        select: {
                            telefone: true,
                            criadoEm: true
                        }
                    }
                },
                take: 20
            }),
            prisma.comissao.findMany({
                where: { userId },
                select: {
                    id: true,
                    valor: true,
                    nivel: true,
                    createdAt: true
                },
                take: 20
            })
        ]);

        if (!user) {
            return res.status(404).json({ 
                success: false,
                mensagem: "Usuário não encontrado" 
            });
        }

        // Preparar resposta
        const responseData = {
            user,
            withdrawals,
            deposits,
            bankAccounts,
            investments,
            earnings,
            referrals,
            commissions,
            totals: {
                withdrawals: withdrawals.reduce((sum, w) => sum + w.amount, 0),
                deposits: deposits.reduce((sum, d) => sum + (d.status === 'approved' ? d.amount : 0), 0),
                earnings: earnings.reduce((sum, e) => sum + e.valor, 0),
                teamCommissions: commissions.reduce((sum, c) => sum + c.valor, 0),
                site_http: "http://popmtr.org" // URL do site
            }
        };

        // Armazenar em cache por 5 minutos
        cache.set(cacheKey, responseData);

        res.json({
            success: true,
            ...responseData,
            cached: false
        });

    } catch (error) {
        console.error("Erro ao buscar informações do usuário:", error);
        res.status(500).json({
            success: false,
            mensagem: "Erro ao buscar informações do usuário",
            error: error.message
        });
    }
});

// Rota otimizada para dados da equipe (com cache)
app.get('/user/team', authenticateJWT, async (req, res) => {
    try {
        const userId = req.user.id;
        const cacheKey = `team_${userId}_data`;

        // Verificar cache
        const cachedData = cache.get(cacheKey);
        if (cachedData) {
            return res.json({
                success: true,
                ...cachedData,
                cached: true
            });
        }

        // Buscar todos os níveis em consultas otimizadas
        const [level1, level2, level3, commissions] = await Promise.all([
            // Nível 1 - indicados diretos
            prisma.$queryRaw`
                SELECT 
                    u.id, 
                    u.telefone, 
                    u.saldo, 
                    u.criadoEm,
                    COALESCE(SUM(c.valor), 0) as comissao
                FROM User u
                JOIN Indicacao i ON u.id = i.indicadoId
                LEFT JOIN Comissao c ON c.userId = ${userId} 
                    AND c.investimentoId IN (
                        SELECT id FROM Investimento WHERE userId = u.id
                    )
                WHERE i.indicadorId = ${userId}
                GROUP BY u.id
            `,
            
            // Nível 2 - indicados dos indicados
            prisma.$queryRaw`
                SELECT 
                    u.id, 
                    u.telefone, 
                    u.saldo, 
                    u.criadoEm,
                    COALESCE(SUM(c.valor), 0) as comissao
                FROM User u
                JOIN Indicacao i2 ON u.id = i2.indicadoId
                JOIN Indicacao i1 ON i2.indicadorId = i1.indicadoId
                LEFT JOIN Comissao c ON c.userId = ${userId} 
                    AND c.investimentoId IN (
                        SELECT id FROM Investimento WHERE userId = u.id
                    )
                WHERE i1.indicadorId = ${userId}
                GROUP BY u.id
            `,
            
            // Nível 3 - indicados dos indicados dos indicados
            prisma.$queryRaw`
                SELECT 
                    u.id, 
                    u.telefone, 
                    u.saldo, 
                    u.criadoEm,
                    COALESCE(SUM(c.valor), 0) as comissao
                FROM User u
                JOIN Indicacao i3 ON u.id = i3.indicadoId
                JOIN Indicacao i2 ON i3.indicadorId = i2.indicadoId
                JOIN Indicacao i1 ON i2.indicadorId = i1.indicadoId
                LEFT JOIN Comissao c ON c.userId = ${userId} 
                    AND c.investimentoId IN (
                        SELECT id FROM Investimento WHERE userId = u.id
                    )
                WHERE i1.indicadorId = ${userId}
                GROUP BY u.id
            `,
            
            // Comissões totais por nível
            prisma.$queryRaw`
                SELECT 
                    nivel,
                    COALESCE(SUM(valor), 0) as total
                FROM Comissao
                WHERE userId = ${userId}
                GROUP BY nivel
            `
        ]);

        // Processar totais de comissão
        const commissionTotals = {
            level1: 0,
            level2: 0,
            level3: 0
        };

        commissions.forEach(row => {
            if (row.nivel === '1') commissionTotals.level1 = parseFloat(row.total);
            if (row.nivel === '2') commissionTotals.level2 = parseFloat(row.total);
            if (row.nivel === '3') commissionTotals.level3 = parseFloat(row.total);
        });

        const responseData = {
            level1,
            level2,
            level3,
            commissions: commissionTotals
        };

        // Armazenar em cache por 5 minutos
        cache.set(cacheKey, responseData);

        res.json({
            success: true,
            ...responseData,
            cached: false
        });

    } catch (error) {
        console.error("Erro ao buscar equipe:", error);
        res.status(500).json({
            success: false,
            mensagem: "Erro ao buscar equipe",
            error: error.message
        });
    }
});

// Rota de login
app.post('/login', async (req, res) => {
    try {
        const { telefone, senha } = req.body;
        
        if (!telefone || !senha) {
            return res.status(400).json({
                success: false,
                mensagem: "Telefone e senha são obrigatórios!"
            });
        }

        const usuario = await prisma.user.findUnique({
            where: { telefone }
        });

        if (!usuario) {
            return res.status(401).json({
                success: false,
                mensagem: "Telefone não cadastrado!"
            });
        }

        const senhaValida = await bcrypt.compare(senha, usuario.senha);
        
        if (!senhaValida) {
            return res.status(401).json({
                success: false,
                mensagem: "Senha incorreta!"
            });
        }

        const token = jwt.sign({ id: usuario.id }, 'SEGREDO_SUPER_SECRETO', { expiresIn: '7d' });

        res.json({
            success: true,
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
        console.error("Erro no login:", error);
        res.status(500).json({
            success: false,
            mensagem: "Erro ao fazer login!",
            error: error.message
        });
    }
});

// Rota de registro
app.post('/usuarios', async (req, res) => {
    try {
        const { telefone, senha, codigoConvite } = req.body;
        
        if (!telefone || !senha) {
            return res.status(400).json({
                success: false,
                mensagem: "Telefone e senha são obrigatórios!"
            });
        }

        if (!telefone.match(/^\+244\d{9}$/)) {
            return res.status(400).json({
                success: false,
                mensagem: "Formato de telefone inválido. Deve ser +244 seguido de 9 dígitos"
            });
        }

        if (senha.length < 6) {
            return res.status(400).json({
                success: false,
                mensagem: "A senha deve ter pelo menos 6 caracteres"
            });
        }

        const usuarioExistente = await prisma.user.findUnique({
            where: { telefone }
        });

        if (usuarioExistente) {
            return res.status(400).json({
                success: false,
                mensagem: "Este telefone já está cadastrado!"
            });
        }

        const senhaHash = await bcrypt.hash(senha, 10);
        const codigoConviteUsuario = Math.random().toString(36).substring(2, 8).toUpperCase();

        const novoUsuario = await prisma.user.create({
            data: {
                telefone,
                senha: senhaHash,
                codigoConvite: codigoConviteUsuario,
                saldo: 300,
                referenciadoPor: null
            }
        });

        // Processar código de convite se existir
        if (codigoConvite) {
            const usuarioReferenciador = await prisma.user.findFirst({
                where: { codigoConvite: codigoConvite }
            });

            if (usuarioReferenciador) {
                await prisma.$transaction([
                    prisma.user.update({
                        where: { id: usuarioReferenciador.id },
                        data: { saldo: { increment: 100 } }
                    }),
                    prisma.indicacao.create({
                        data: {
                            indicadorId: usuarioReferenciador.id,
                            indicadoId: novoUsuario.id,
                            codigoConvite: codigoConvite
                        }
                    })
                ]);

                invalidateUserCache(usuarioReferenciador.id);
            }
        }

        const token = jwt.sign({ id: novoUsuario.id }, 'SEGREDO_SUPER_SECRETO', { expiresIn: '7d' });

        res.status(201).json({
            success: true,
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
        res.status(500).json({
            success: false,
            mensagem: "Erro ao criar usuário!",
            error: error.message
        });
    }
});

// Rota para comprar produto (com distribuição de comissões)
app.post('/products/purchase', authenticateJWT, async (req, res) => {
    try {
        const userId = req.user.id;
        const { productId } = req.body;

        if (!productId) {
            return res.status(400).json({
                success: false,
                mensagem: "ID do produto é obrigatório!"
            });
        }

        const products = {
            '1': { price: 5000, name: "Pacote Básico", day_income: 200, days: 30 },
            '2': { price: 10000, name: "Pacote Standard", day_income: 450, days: 60 },
            '3': { price: 20000, name: "Pacote Premium", day_income: 1000, days: 90 },
            '4': { price: 50000, name: "Pacote Gold", day_income: 2500, days: 120 },
            '5': { price: 100000, name: "Pacote Platinum", day_income: 6000, days: 180 },
            '6': { price: 200000, name: "Pacote Diamond", day_income: 13000, days: 240 },
            '7': { price: 500000, name: "Pacote VIP", day_income: 35000, days: 360 },
            '8': { price: 1000000, name: "Pacote Premium VIP", day_income: 80000, days: 720 }
        };

        const product = products[productId];
        if (!product) {
            return res.status(404).json({
                success: false,
                mensagem: "Produto não encontrado!"
            });
        }

        const result = await prisma.$transaction(async (prisma) => {
            const user = await prisma.user.findUnique({
                where: { id: userId },
                select: { saldo: true, referenciadoPor: true }
            });

            if (!user) throw new Error("Usuário não encontrado");
            if (user.saldo < product.price) throw new Error("Saldo insuficiente");

            // Atualizar saldo do usuário
            await prisma.user.update({
                where: { id: userId },
                data: { saldo: { decrement: product.price } }
            });

            // Criar investimento
            const investment = await prisma.investimento.create({
                data: {
                    produto: product.name,
                    valor: product.price,
                    user: { connect: { id: userId } },
                    ultimoPagamento: new Date()
                }
            });

            // Distribuir comissões se houver referenciador
            if (user.referenciadoPor) {
                await distributeBonuses(prisma, userId, user.referenciadoPor, product.price, investment.id);
            }

            return { investment };
        });

        invalidateUserCache(userId);

        const updatedUser = await prisma.user.findUnique({
            where: { id: userId },
            select: { saldo: true }
        });

        res.json({
            success: true,
            mensagem: "Compra realizada com sucesso!",
            saldoAtualizado: updatedUser.saldo
        });

    } catch (error) {
        console.error("Erro ao processar compra:", error);

        if (error.message === "Saldo insuficiente") {
            return res.status(400).json({
                success: false,
                mensagem: "Saldo insuficiente para esta compra",
                redirectTo: "/deposito.html"
            });
        }

        res.status(500).json({
            success: false,
            mensagem: "Erro ao processar compra",
            error: error.message
        });
    }
});

// Função para distribuir bônus para a equipe
async function distributeBonuses(prisma, userId, referenciadorId, investmentAmount, investmentId) {
    try {
        // Nível 1 - referenciador direto (20%)
        const bonusNivel1 = investmentAmount * 0.20;
        await prisma.$transaction([
            prisma.user.update({
                where: { id: referenciadorId },
                data: { saldo: { increment: bonusNivel1 } }
            }),
            prisma.comissao.create({
                data: {
                    userId: referenciadorId,
                    valor: bonusNivel1,
                    nivel: "1",
                    investimentoId: investmentId,
                    valorInvestimento: investmentAmount
                }
            })
        ]);

        // Nível 2 - referenciador do referenciador (8%)
        const referenciador = await prisma.user.findUnique({
            where: { id: referenciadorId },
            select: { referenciadoPor: true }
        });

        if (referenciador && referenciador.referenciadoPor) {
            const bonusNivel2 = investmentAmount * 0.08;
            await prisma.$transaction([
                prisma.user.update({
                    where: { id: referenciador.referenciadoPor },
                    data: { saldo: { increment: bonusNivel2 } }
                }),
                prisma.comissao.create({
                    data: {
                        userId: referenciador.referenciadoPor,
                        valor: bonusNivel2,
                        nivel: "2",
                        investimentoId: investmentId,
                        valorInvestimento: investmentAmount
                    }
                })
            ]);

            // Nível 3 - referenciador do referenciador do referenciador (2%)
            const nivel2User = await prisma.user.findUnique({
                where: { id: referenciador.referenciadoPor },
                select: { referenciadoPor: true }
            });

            if (nivel2User && nivel2User.referenciadoPor) {
                const bonusNivel3 = investmentAmount * 0.02;
                await prisma.$transaction([
                    prisma.user.update({
                        where: { id: nivel2User.referenciadoPor },
                        data: { saldo: { increment: bonusNivel3 } }
                    }),
                    prisma.comissao.create({
                        data: {
                            userId: nivel2User.referenciadoPor,
                            valor: bonusNivel3,
                            nivel: "3",
                            investimentoId: investmentId,
                            valorInvestimento: investmentAmount
                        }
                    })
                ]);

                invalidateUserCache(nivel2User.referenciadoPor);
            }

            invalidateUserCache(referenciador.referenciadoPor);
        }

        invalidateUserCache(referenciadorId);

    } catch (error) {
        console.error("Erro ao distribuir bônus:", error);
        throw error;
    }
}

// Middleware de erro global
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ 
        success: false,
        mensagem: 'Erro interno no servidor' 
    });
});

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});