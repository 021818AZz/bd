const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const NodeCache = require('node-cache');

const prisma = new PrismaClient();
const app = express();
const PORT = 3333;

// Configuração do cache com TTL de 30 segundos
const cache = new NodeCache({ stdTTL: 30, checkperiod: 60 });

// Middleware para invalidar cache do usuário
const invalidateUserCache = (userId) => {
    const userCacheKeys = [
        `user_${userId}_data`,
        `user_${userId}_balance`,
        `user_${userId}_team`,
        `user_${userId}_investments`
    ];
    cache.del(userCacheKeys);
};

// Configuração do CORS e JSON
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

// Rota para obter saldo e retiradas com cache
app.get('/user/balance', authenticateJWT, async (req, res) => {
    try {
        const userId = req.user.id;
        const cacheKey = `user_${userId}_balance`;
        
        // Verificar cache
        const cachedData = cache.get(cacheKey);
        if (cachedData) {
            return res.json({
                ...cachedData,
                cached: true,
                timestamp: new Date()
            });
        }

        // Busca em paralelo para melhor performance
        const [user, withdrawals] = await Promise.all([
            prisma.user.findUnique({
                where: { id: userId },
                select: { saldo: true }
            }),
            prisma.withdrawal.aggregate({
                where: { user_id: userId },
                _sum: { amount: true }
            })
        ]);

        if (!user) {
            return res.status(404).json({ 
                success: false,
                mensagem: "Usuário não encontrado" 
            });
        }

        const responseData = {
            success: true,
            saldo: user.saldo,
            totalRetiradas: withdrawals._sum.amount || 0
        };

        // Atualizar cache
        cache.set(cacheKey, responseData);

        res.json({
            ...responseData,
            cached: false,
            timestamp: new Date()
        });

    } catch (error) {
        console.error("Erro ao buscar saldo:", error);
        res.status(500).json({
            success: false,
            mensagem: "Erro ao buscar saldo",
            error: error.message
        });
    }
});

// Rota /me com cache otimizado
app.get('/me', authenticateJWT, async (req, res) => {
    try {
        const userId = req.user.id;
        const cacheKey = `user_${userId}_data`;

        // Verificar cache
        const cachedData = cache.get(cacheKey);
        if (cachedData) {
            return res.json({
                ...cachedData,
                cached: true,
                timestamp: new Date()
            });
        }

        // Busca em paralelo com índices otimizados
        const [
            user, 
            withdrawals, 
            deposits, 
            bankAccounts, 
            investments, 
            earnings, 
            referrals, 
            commissions
        ] = await Promise.all([
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
                    created_at: true,
                    bank_account: {
                        select: {
                            bank: true,
                            account_number: true
                        }
                    }
                },
                orderBy: { created_at: 'desc' },
                take: 20
            }),
            prisma.deposit.findMany({
                where: { userId },
                select: {
                    id: true,
                    amount: true,
                    status: true,
                    createdAt: true,
                    bank: true
                },
                orderBy: { createdAt: 'desc' },
                take: 20
            }),
            prisma.bankAccount.findMany({
                where: { userId },
                select: {
                    id: true,
                    bank: true,
                    account_number: true,
                    account_holder: true
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
                orderBy: { data: 'desc' },
                take: 10
            }),
            prisma.rendimento.findMany({
                where: { userId },
                select: {
                    id: true,
                    valor: true,
                    data: true
                },
                orderBy: { data: 'desc' },
                take: 20
            }),
            prisma.indicacao.findMany({
                where: { indicadorId: userId },
                select: {
                    dataIndicacao: true,
                    indicado: {
                        select: {
                            telefone: true,
                            criadoEm: true,
                            saldo: true
                        }
                    }
                },
                orderBy: { dataIndicacao: 'desc' },
                take: 20
            }),
            prisma.comissao.findMany({
                where: { userId },
                select: {
                    id: true,
                    valor: true,
                    nivel: true,
                    createdAt: true,
                    valorInvestimento: true
                },
                orderBy: { createdAt: 'desc' },
                take: 20
            })
        ]);

        if (!user) {
            return res.status(404).json({ 
                success: false,
                mensagem: "Usuário não encontrado" 
            });
        }

        // Calcular totais
        const responseData = {
            success: true,
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
                commissions: commissions.reduce((sum, c) => sum + c.valor, 0)
            }
        };

        // Atualizar cache
        cache.set(cacheKey, responseData);

        res.json({
            ...responseData,
            cached: false,
            timestamp: new Date()
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

// Rota para equipe com cache
app.get('/user/team', authenticateJWT, async (req, res) => {
    try {
        const userId = req.user.id;
        const cacheKey = `user_${userId}_team`;

        // Verificar cache
        const cachedData = cache.get(cacheKey);
        if (cachedData) {
            return res.json({
                ...cachedData,
                cached: true,
                timestamp: new Date()
            });
        }

        // Nível 1 - indicados diretos
        const level1 = await prisma.indicacao.findMany({
            where: { indicadorId: userId },
            select: {
                indicado: {
                    select: {
                        id: true,
                        telefone: true,
                        saldo: true,
                        criadoEm: true
                    }
                }
            }
        });

        // Nível 2 - indicados dos indicados
        const level1Ids = level1.map(i => i.indicado.id);
        const level2 = await prisma.indicacao.findMany({
            where: { indicadorId: { in: level1Ids } },
            select: {
                indicado: {
                    select: {
                        id: true,
                        telefone: true,
                        saldo: true,
                        criadoEm: true
                    }
                }
            }
        });

        // Nível 3 - indicados dos indicados dos indicados
        const level2Ids = level2.map(i => i.indicado.id);
        const level3 = await prisma.indicacao.findMany({
            where: { indicadorId: { in: level2Ids } },
            select: {
                indicado: {
                    select: {
                        id: true,
                        telefone: true,
                        saldo: true,
                        criadoEm: true
                    }
                }
            }
        });

        const responseData = {
            success: true,
            level1: level1.map(i => i.indicado),
            level2: level2.map(i => i.indicado),
            level3: level3.map(i => i.indicado)
        };

        // Atualizar cache
        cache.set(cacheKey, responseData);

        res.json({
            ...responseData,
            cached: false,
            timestamp: new Date()
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

// Rota para comprar produto com invalidação de cache
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

            await prisma.user.update({
                where: { id: userId },
                data: { saldo: { decrement: product.price } }
            });

            const investment = await prisma.investimento.create({
                data: {
                    produto: product.name,
                    valor: product.price,
                    user: { connect: { id: userId } },
                    ultimoPagamento: new Date()
                }
            });

            if (user.referenciadoPor) {
                await distributeBonuses(prisma, userId, user.referenciadoPor, product.price, investment.id);
            }

            return { investment };
        });

        // Invalida cache do usuário e referenciadores
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

// Função para distribuir bônus com cache
async function distributeBonuses(prisma, userId, referenciadorId, investmentAmount, investmentId) {
    console.log("🧠 Distribuindo bônus para:", userId, "Referenciador:", referenciadorId);

    // Obter referenciador
    const referenciador = await prisma.user.findUnique({
        where: { id: referenciadorId }
    });

    if (!referenciador) return;

    // Nível 1 - referenciador direto (28%)
    const bonusNivel1 = investmentAmount * 0.28;
    await prisma.user.update({
        where: { id: referenciador.id },
        data: { saldo: { increment: bonusNivel1 } }
    });

    await prisma.comissao.create({
        data: {
            userId: referenciador.id,
            valor: bonusNivel1,
            nivel: "1",
            investimentoId: investmentId,
            valorInvestimento: investmentAmount
        }
    });

    // Nível 2 - referenciador do referenciador (2%)
    if (referenciador.referenciadoPor) {
        const bonusNivel2 = investmentAmount * 0.02;
        await prisma.user.update({
            where: { id: referenciador.referenciadoPor },
            data: { saldo: { increment: bonusNivel2 } }
        });

        await prisma.comissao.create({
            data: {
                userId: referenciador.referenciadoPor,
                valor: bonusNivel2,
                nivel: "2",
                investimentoId: investmentId,
                valorInvestimento: investmentAmount
            }
        });

        // Nível 3 - referenciador do referenciador do referenciador (1%)
        const nivel2User = await prisma.user.findUnique({
            where: { id: referenciador.referenciadoPor },
            select: { referenciadoPor: true }
        });

        if (nivel2User && nivel2User.referenciadoPor) {
            const bonusNivel3 = investmentAmount * 0.01;
            await prisma.user.update({
                where: { id: nivel2User.referenciadoPor },
                data: { saldo: { increment: bonusNivel3 } }
            });

            await prisma.comissao.create({
                data: {
                    userId: nivel2User.referenciadoPor,
                    valor: bonusNivel3,
                    nivel: "3",
                    investimentoId: investmentId,
                    valorInvestimento: investmentAmount
                }
            });
        }
    }

    // Invalidar cache dos usuários que receberam bônus
    invalidateUserCache(referenciador.id);
    if (referenciador.referenciadoPor) {
        invalidateUserCache(referenciador.referenciadoPor);
        const nivel2User = await prisma.user.findUnique({
            where: { id: referenciador.referenciadoPor },
            select: { referenciadoPor: true }
        });
        if (nivel2User && nivel2User.referenciadoPor) {
            invalidateUserCache(nivel2User.referenciadoPor);
        }
    }
}

// Rota para produtos com cache
app.get('/products', async (req, res) => {
    try {
        const cacheKey = 'products_list';
        
        // Verificar cache
        const cachedData = cache.get(cacheKey);
        if (cachedData) {
            return res.json({
                ...cachedData,
                cached: true,
                timestamp: new Date()
            });
        }

        const products = [
            { id: '1', name: "Projeto 1", price: 5000, day_income: 600, days: 50, total_income: 30000 },
            { id: '2', name: "Projeto 2", price: 10000, day_income: 1200, days: 50, total_income: 60000 },
            { id: '3', name: "Projeto 3", price: 30000, day_income: 3600, days: 50, total_income: 180000 },
            { id: '4', name: "Projeto 4", price: 50000, day_income: 6000, days: 50, total_income: 300000 },
            { id: '5', name: "Projeto 5", price: 100000, day_income: 12000, days: 50, total_income: 600000 },
            { id: '6', name: "Projeto 6", price: 150000, day_income: 18000, days: 50, total_income: 900000 },
            { id: '7', name: "Projeto 7", price: 300000, day_income: 36000, days: 50, total_income: 1800000 },
            { id: '8', name: "Projeto 8", price: 600000, day_income: 72000, days: 50, total_income: 3600000 }
        ];

        const responseData = {
            success: true,
            products
        };

        // Atualizar cache
        cache.set(cacheKey, responseData);

        res.json({
            ...responseData,
            cached: false,
            timestamp: new Date()
        });
    } catch (error) {
        console.error("Erro ao buscar produtos:", error);
        res.status(500).json({
            success: false,
            mensagem: "Erro ao buscar produtos",
            error: error.message
        });
    }
});


// Rota para registrar rendimento de um produto
router.post('/registroproduto/rendimento', authMiddleware, async (req, res) => {
    try {
        const { productId, amount } = req.body;
        const userId = req.user.id;

        // 1. Verificar se o produto pertence ao usuário e está ativo
        const product = await ProductRegistration.findOne({
            _id: productId,
            userId,
            status: 'active'
        });

        if (!product) {
            return res.status(404).json({
                success: false,
                message: 'Produto não encontrado ou não está ativo'
            });
        }

        // 2. Verificar se já foi registrado hoje
        const lastPayment = product.lastPaymentDate;
        const today = new Date();
        
        if (lastPayment && new Date(lastPayment).toDateString() === today.toDateString()) {
            return res.status(400).json({
                success: false,
                message: 'A renda deste produto já foi registrada hoje'
            });
        }

        // 3. Atualizar saldo do usuário
        const updatedUser = await User.findByIdAndUpdate(
            userId,
            { $inc: { saldo: amount } },
            { new: true }
        );

        // 4. Registrar o rendimento
        const newIncome = new Rendimento({
            userId,
            valor: amount,
            productId,
            data: new Date()
        });

        await newIncome.save();

        // 5. Atualizar último pagamento do produto
        product.lastPaymentDate = new Date();
        await product.save();

        res.json({
            success: true,
            message: 'Renda registrada com sucesso',
            newBalance: updatedUser.saldo
        });

    } catch (error) {
        console.error('Erro ao registrar rendimento:', error);
        res.status(500).json({
            success: false,
            message: 'Erro ao registrar rendimento'
        });
    }
});
// Rota de aposta com invalidação de cache
app.post("/game/bet", authenticateJWT, async (req, res) => {
    try {
        const userId = req.user.id;
        const { amount, gameType, result } = req.body;

        if (!amount || !gameType || !result) {
            return res.status(400).json({
                success: false,
                mensagem: "Dados da aposta incompletos!"
            });
        }

        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { saldo: true }
        });

        if (!user) {
            return res.status(404).json({ success: false, mensagem: "Usuário não encontrado" });
        }

        let newBalance = user.saldo - amount;
        if (result.winAmount && result.winAmount > 0) {
            newBalance += result.winAmount;
        }

        await prisma.user.update({
            where: { id: userId },
            data: { saldo: newBalance }
        });

        await prisma.gameBet.create({
            data: {
                userId: userId,
                amount: amount,
                gameType: gameType,
                winAmount: result.winAmount || 0,
                reels: JSON.stringify(result.reels),
                symbols: JSON.stringify(result.symbols)
            }
        });

        // Invalida cache do usuário
        invalidateUserCache(userId);

        res.json({
            success: true,
            mensagem: "Aposta processada com sucesso!",
            newBalance: newBalance
        });

    } catch (error) {
        console.error("Erro ao processar aposta:", error);
        res.status(500).json({
            success: false,
            mensagem: "Erro interno ao processar aposta",
            error: error.message
        });
    }
});

// Rota de login com cache para tentativas
app.post('/login', async (req, res) => {
    try {
        const { telefone, senha } = req.body;
        const cacheKey = `login_attempt_${telefone}`;
        
        // Verificar tentativas recentes (proteção contra brute force)
        const attempts = cache.get(cacheKey) || 0;
        if (attempts >= 5) {
            return res.status(429).json({
                success: false,
                mensagem: "Muitas tentativas de login. Tente novamente mais tarde."
            });
        }

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
            cache.set(cacheKey, attempts + 1, 300); // 5 minutos de bloqueio
            return res.status(401).json({
                success: false,
                mensagem: "Telefone não cadastrado!"
            });
        }

        const senhaValida = await bcrypt.compare(senha, usuario.senha);
        
        if (!senhaValida) {
            cache.set(cacheKey, attempts + 1, 300); // 5 minutos de bloqueio
            return res.status(401).json({
                success: false,
                mensagem: "Senha incorreta!"
            });
        }

        // Resetar contador de tentativas
        cache.del(cacheKey);

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

// Rota para verificar telefone com cache
app.post('/usuarios/verificar', async (req, res) => {
    try {
        const { telefone } = req.body;
        const cacheKey = `user_verify_${telefone}`;
        
        // Verificar cache
        const cachedData = cache.get(cacheKey);
        if (cachedData) {
            return res.json({
                ...cachedData,
                cached: true,
                timestamp: new Date()
            });
        }

        if (!telefone) {
            return res.status(400).json({ 
                success: false,
                mensagem: "Telefone é obrigatório!" 
            });
        }

        const usuarioExistente = await prisma.user.findUnique({
            where: { telefone }
        });

        const responseData = { 
            success: true,
            existe: !!usuarioExistente 
        };

        // Atualizar cache (cache mais longo para dados que raramente mudam)
        cache.set(cacheKey, responseData, 600); // 10 minutos

        res.json({
            ...responseData,
            cached: false,
            timestamp: new Date()
        });
    } catch (error) {
        console.error("Erro ao verificar telefone:", error);
        res.status(500).json({ 
            success: false,
            mensagem: "Erro ao verificar telefone",
            error: error.message 
        });
    }
});

// Rota de registro com invalidação de cache
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

        if (codigoConvite) {
            const usuarioReferenciador = await prisma.user.findFirst({
                where: { codigoConvite: codigoConvite }
            });

            if (usuarioReferenciador) {
                await prisma.user.update({
                    where: { id: usuarioReferenciador.id },
                    data: { saldo: { increment: 0 } }
                });

                await prisma.indicacao.create({
                    data: {
                        indicadorId: usuarioReferenciador.id,
                        indicadoId: novoUsuario.id,
                        codigoConvite: codigoConvite
                    }
                });

                // Invalida cache do referenciador
                invalidateUserCache(usuarioReferenciador.id);
            }
        }

        const token = jwt.sign({ id: novoUsuario.id }, 'SEGREDO_SUPER_SECRETO', { expiresIn: '7d' });

        // Invalida cache de verificação de telefone
        cache.del(`user_verify_${telefone}`);

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

// Middleware de erro
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ mensagem: 'Erro interno no servidor' });
});

app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});