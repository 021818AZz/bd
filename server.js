const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const app = express();
const PORT = 3333;
// Configuração do CORS e JSON
app.use(cors());
app.use(express.json());

// Adicione este middleware para autenticação JWT
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

// Rota para obter saldo e retiradas (protegida por JWT)
app.get('/user/balance', authenticateJWT, async (req, res) => {
    try {
        const userId = req.user.id;
        
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

        res.json({
            success: true,
            saldo: user.saldo,
            totalRetiradas: withdrawals._sum.amount || 0
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

// Versão GET para /user/balance (já existe como GET original)
app.get('/user/balance', authenticateJWT, (req, res) => {
  res.send('GET protegida disponível para /user/balance');
});

// Middleware de erro
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ mensagem: 'Erro interno no servidor' });
});

const NodeCache = require('node-cache');
const cache = new NodeCache({ stdTTL: 30, checkperiod: 60 }); // Cache de 30 segundos

// Rota /me com cache e otimizações
app.get('/me', authenticateJWT, async (req, res) => {
    try {
        const userId = req.user.id;
        const cacheKey = `user_${userId}_data`;

        // Verifica se há cache válido
        const cachedData = cache.get(cacheKey);
        if (cachedData) {
            return res.json({
                success: true,
                ...cachedData,
                cached: true,
                timestamp: new Date()
            });
        }

        // Busca dados em paralelo com otimizações
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
                take: 20 // Limita para melhor performance
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

        // Calcula totais
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
                commissions: commissions.reduce((sum, c) => sum + c.valor, 0)
            }
        };

        // Atualiza cache
        cache.set(cacheKey, responseData);

        res.json({
            success: true,
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

// Versão GET para /me (já existe como GET original)
app.get('/me', authenticateJWT, (req, res) => {
  res.send('GET protegida disponível para /me');
});

// Middleware para invalidar cache quando houver alterações relevantes
const invalidateUserCache = (userId) => {
    const cacheKey = `user_${userId}_data`;
    cache.del(cacheKey);
};

// Exemplo de uso em outras rotas que modificam dados:
app.post('/withdrawals', authenticateJWT, async (req, res) => {
    try {
        // ... lógica de criação de retirada
        invalidateUserCache(req.user.id);
        // ... resto do código
    } catch (error) {
        // ... tratamento de erro
    }
});

// Versão GET para /withdrawals
app.get('/withdrawals', authenticateJWT, (req, res) => {
  res.send('GET protegida disponível para /withdrawals');
});

// Rota de login
app.post('/login', async (req, res) => {
    try {
        const { telefone, senha } = req.body;
        
        // Validações básicas
        if (!telefone || !senha) {
            return res.status(400).json({
                success: false,
                mensagem: "Telefone e senha são obrigatórios!"
            });
        }

        // Buscar usuário no banco de dados
        const usuario = await prisma.user.findUnique({
            where: { telefone }
        });

        if (!usuario) {
            return res.status(401).json({
                success: false,
                mensagem: "Telefone não cadastrado!"
            });
        }

        // Verificar senha
        const senhaValida = await bcrypt.compare(senha, usuario.senha);
        
        if (!senhaValida) {
            return res.status(401).json({
                success: false,
                mensagem: "Senha incorreta!"
            });
        }

        // Gerar token JWT
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

// Rota para verificar telefone
app.post('/usuarios/verificar', async (req, res) => {
    try {
        const { telefone } = req.body;
        
        if (!telefone) {
            return res.status(400).json({ 
                success: false,
                mensagem: "Telefone é obrigatório!" 
            });
        }

        const usuarioExistente = await prisma.user.findUnique({
            where: { telefone }
        });

        res.json({ 
            success: true,
            existe: !!usuarioExistente 
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

// Rota para obter dados da equipe (3 níveis)
app.get('/user/team', authenticateJWT, async (req, res) => {
    try {
        const userId = req.user.id;

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

        res.json({
            success: true,
            level1: level1.map(i => i.indicado),
            level2: level2.map(i => i.indicado),
            level3: level3.map(i => i.indicado)
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

// Versão GET para /user/team (já existe como GET original)
app.get('/user/team', authenticateJWT, (req, res) => {
  res.send('GET protegida disponível para /user/team');
});

// Rota para comprar produto
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

// Versão GET para /products/purchase
app.get('/products/purchase', authenticateJWT, (req, res) => {
  res.send('GET protegida disponível para /products/purchase');
});

// Função para distribuir bônus para a equipe
async function distributeBonuses(prisma, userId, referenciadorId, investmentAmount, investmentId) {
    console.log("🧠 Distribuindo bônus para:", userId, "Referenciador:", referenciadorId);

    // Obter toda a árvore de referência (3 níveis)
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { saldo: true, referenciadoPor: true }
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

// Rota para obter produtos
app.get('/products', async (req, res) => {
    try {
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

        res.json({
            success: true,
            products
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

app.post("/game/bet", authenticateJWT, async (req, res) => {
    try {
        const userId = req.user.id;
        const { amount, gameType, result } = req.body;

        // Validações básicas
        if (!amount || !gameType || !result) {
            return res.status(400).json({
                success: false,
                mensagem: "Dados da aposta incompletos!"
            });
        }

        // Busca o saldo do usuário
        const user = await prisma.User.findUnique({
            where: { id: userId },
            select: { saldo: true }
        });

        if (!user) {
            return res.status(404).json({ success: false, mensagem: "Usuário não encontrado" });
        }

        let newBalance = user.saldo - amount; // Deduz o valor da aposta

        // Se houver vitória, adiciona o valor ganho
        if (result.winAmount && result.winAmount > 0) {
            newBalance += result.winAmount;
        }

        await prisma.User.update({
            where: { id: userId },
            data: { saldo: newBalance }
        });

        // Registrar a aposta no banco de dados
        prisma.gameBet.create({


            data: {
                userId: userId,
                amount: amount,
                gameType: gameType,
                winAmount: result.winAmount || 0,
                reels: JSON.stringify(result.reels), // Salva o resultado dos rolos
                symbols: JSON.stringify(result.symbols) // Salva os símbolos
            }
        });

        // Invalida o cache do usuário para que o saldo seja atualizado
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



// Rota de registro
app.post('/usuarios', async (req, res) => {
    try {
        const { telefone, senha, codigoConvite } = req.body;
        
        // Validações básicas
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

        // Verificar se usuário já existe
        const usuarioExistente = await prisma.user.findUnique({
            where: { telefone }
        });

        if (usuarioExistente) {
            return res.status(400).json({
                success: false,
                mensagem: "Este telefone já está cadastrado!"
            });
        }

        // Criar novo usuário
        const senhaHash = await bcrypt.hash(senha, 10);
        const codigoConviteUsuario = Math.random().toString(36).substring(2, 8).toUpperCase();

        const novoUsuario = await prisma.user.create({
            data: {
                telefone,
                senha: senhaHash,
                codigoConvite: codigoConviteUsuario,
                saldo: 400,
                referenciadoPor: null
            }
        });

        // Se houver código de convite
        if (codigoConvite) {
            const usuarioReferenciador = await prisma.user.findFirst({
                where: { codigoConvite: codigoConvite }
            });

            if (usuarioReferenciador) {
                await prisma.user.update({
                    where: { id: usuarioReferenciador.id },
                    data: { saldo: { increment: 500 } }
                });

                await prisma.indicacao.create({
                    data: {
                        indicadorId: usuarioReferenciador.id,
                        indicadoId: novoUsuario.id,
                        codigoConvite: codigoConvite
                    }
                });
            }
        }

        // Gerar token JWT
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

// Versão GET para /usuarios (não adicionada pois é uma rota pública de POST)

app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});