const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 3000;

const JWT_SECRET = process.env.JWT_SECRET || 'seu_segredo_jwt_super_seguro_aqui';

// Middleware otimizado
app.use(cors({
  origin: "*"
}));

app.use(express.json({ limit: '10mb' }));

// Middleware de logs simplificado
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// Middleware de autenticação JWT
const authenticateToken = async (req, res, next) => {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

        if (!token) {
            return res.status(401).json({
                success: false,
                message: 'Token de acesso necessário'
            });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        
        // Verificar se o usuário ainda existe no banco
        const user = await prisma.user.findUnique({
            where: { id: decoded.userId },
            select: { id: true, mobile: true }
        });

        if (!user) {
            return res.status(401).json({
                success: false,
                message: 'Usuário não encontrado'
            });
        }

        req.user = user;
        next();
    } catch (error) {
        console.error('Erro na autenticação:', error);
        
        if (error.name === 'JsonWebTokenError') {
            return res.status(403).json({
                success: false,
                message: 'Token inválido'
            });
        }
        
        if (error.name === 'TokenExpiredError') {
            return res.status(403).json({
                success: false,
                message: 'Token expirado'
            });
        }

        res.status(500).json({
            success: false,
            message: 'Erro na autenticação'
        });
    }
};

// Middleware de autorização (verifica se o usuário acessa apenas seus próprios dados)
const authorizeUser = (req, res, next) => {
    const userId = req.params.id;
    
    if (req.user.id !== userId) {
        return res.status(403).json({
            success: false,
            message: 'Acesso não autorizado'
        });
    }
    
    next();
};

// Health check (público)
app.get('/health', async (req, res) => {
    res.status(200).json({ 
        success: true, 
        message: 'Servidor está funcionando',
        timestamp: new Date().toISOString()
    });
});


// Rota para obter perfil do usuário (incluindo saldo)
app.get('/user/profile', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.id;
        
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                mobile: true,
                saldo: true,
                invitation_code: true,
                created_at: true,
                updated_at: true
            }
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'Usuário não encontrado'
            });
        }

        res.json({
            success: true,
            data: {
                user_id: user.id,
                mobile: user.mobile,
                wallet_balance: user.saldo, // Saldo para a carteira flexível
                invitation_code: user.invitation_code,
                created_at: user.created_at,
                updated_at: user.updated_at
            }
        });

    } catch (error) {
        console.error('Erro ao buscar perfil do usuário:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});


// Rota de login (pública)
app.post('/login', async (req, res) => {
    try {
        const { mobile, password } = req.body;
        
        if (!mobile || !password) {
            return res.status(400).json({
                success: false,
                message: 'Telefone e senha são obrigatórios'
            });
        }

        const user = await prisma.user.findUnique({
            where: { mobile },
            select: { 
                id: true, 
                password: true, 
                mobile: true, 
                saldo: true,
                invitation_code: true 
            }
        });

        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({
                success: false,
                message: 'Credenciais inválidas'
            });
        }

        const token = jwt.sign(
            { userId: user.id }, 
            JWT_SECRET, 
            { expiresIn: '24h' }
        );

        res.json({
            success: true,
            message: 'Login realizado com sucesso',
            data: {
                user: {
                    id: user.id,
                    mobile: user.mobile,
                    saldo: user.saldo,
                    invitation_code: user.invitation_code
                },
                token
            }
        });

    } catch (error) {
        console.error('Erro no login:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota de registro (pública)
// Rota de registro (pública)
app.post('/register', async (req, res) => {
    try {
        const { mobile, password, pay_password, invitation_code, saldo } = req.body;
        
        // Validações básicas
        if (!mobile || !password || !pay_password) {
            return res.status(400).json({
                success: false,
                message: 'Telefone, senha e senha de pagamento são obrigatórios'
            });
        }

        // Verificar se usuário já existe
        const existingUser = await prisma.user.findUnique({
            where: { mobile }
        });

        if (existingUser) {
            return res.status(409).json({
                success: false,
                message: 'Número de telefone já cadastrado'
            });
        }

        // Verificar código de convite se fornecido
        let inviterId = null;
        if (invitation_code) {
            const inviter = await prisma.user.findUnique({
                where: { invitation_code: invitation_code.toUpperCase() }
            });
            
            if (!inviter) {
                return res.status(400).json({
                    success: false,
                    message: 'Código de convite inválido'
                });
            }
            inviterId = inviter.id;
        }

        // Gerar código de convite único
        let invitationCode;
        let isUnique = false;
        
        while (!isUnique) {
            invitationCode = generateInvitationCode();
            const existingCode = await prisma.user.findUnique({
                where: { invitation_code: invitationCode }
            });
            if (!existingCode) isUnique = true;
        }

        // Criptografar senhas
        const hashedPassword = await bcrypt.hash(password, 10);
        const hashedPayPassword = await bcrypt.hash(pay_password, 10);

        // Criar usuário
        const newUser = await prisma.user.create({
            data: {
                mobile,
                password: hashedPassword,
                pay_password: hashedPayPassword,
                invitation_code: invitationCode,
                saldo: saldo || 570,
                inviter_id: inviterId,
                created_at: new Date(),
                updated_at: new Date()
            }
        });

        // Se houver um inviter, criar registros na rede de referência
        if (inviterId) {
            await createReferralNetwork(inviterId, newUser.id);
        }

        res.status(201).json({
            success: true,
            message: 'Usuário cadastrado com sucesso',
            data: {
                user_id: newUser.id,
                mobile: newUser.mobile,
                invitation_code: newUser.invitation_code
            }
        });

    } catch (error) {
        console.error('Erro no registro:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Função auxiliar para gerar código de convite
function generateInvitationCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// Função auxiliar para criar rede de referência
async function createReferralNetwork(inviterId, newUserId) {
    try {
        // Nível 1: convidador direto
        await prisma.referralLevel.create({
            data: {
                referrer_id: inviterId,
                user_id: newUserId,
                level: 1
            }
        });

        // Buscar o convidador do convidador (nível 2)
        const level2Inviter = await prisma.user.findUnique({
            where: { id: inviterId },
            select: { inviter_id: true }
        });

        if (level2Inviter && level2Inviter.inviter_id) {
            await prisma.referralLevel.create({
                data: {
                    referrer_id: level2Inviter.inviter_id,
                    user_id: newUserId,
                    level: 2
                }
            });

            // Buscar o convidador do nível 2 (nível 3)
            const level3Inviter = await prisma.user.findUnique({
                where: { id: level2Inviter.inviter_id },
                select: { inviter_id: true }
            });

            if (level3Inviter && level3Inviter.inviter_id) {
                await prisma.referralLevel.create({
                    data: {
                        referrer_id: level3Inviter.inviter_id,
                        user_id: newUserId,
                        level: 3
                    }
                });
            }
        }
    } catch (error) {
        console.error('Erro ao criar rede de referência:', error);
    }
}

// Rota para verificar código de convite (pública)
app.get('/invitation/:code/verify', async (req, res) => {
    // ... (código anterior mantido igual)
});

// TODAS AS ROTAS ABAIXO SÃO PROTEGIDAS ===============================

// Rota para obter informações do usuário (protegida)
app.get('/user/:id', authenticateToken, authorizeUser, async (req, res) => {
    try {
        const userId = req.params.id;
        
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                mobile: true,
                saldo: true,
                invitation_code: true,
                created_at: true,
                inviter_id: true
            }
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'Usuário não encontrado'
            });
        }

        res.json({
            success: true,
            data: user
        });

    } catch (error) {
        console.error('Erro ao buscar usuário:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para obter informações completas do usuário (protegida)
app.get('/user/:id/full-profile', authenticateToken, authorizeUser, async (req, res) => {
    try {
        const userId = req.params.id;
        
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                mobile: true,
                saldo: true,
                invitation_code: true,
                created_at: true,
                updated_at: true,
                inviter_id: true,
            }
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: 'Usuário não encontrado'
            });
        }

        let inviterInfo = null;
        if (user.inviter_id) {
            inviterInfo = await prisma.user.findUnique({
                where: { id: user.inviter_id },
                select: {
                    id: true,
                    mobile: true,
                    invitation_code: true
                }
            });
        }

        const referralNetwork = await prisma.referralLevel.findMany({
            where: { referrer_id: userId },
            include: {
                user: {
                    select: {
                        id: true,
                        mobile: true,
                        saldo: true,
                        invitation_code: true,
                        created_at: true
                    }
                }
            },
            orderBy: {
                level: 'asc'
            }
        });

        const organizedReferrals = {
            level1: referralNetwork.filter(item => item.level === 1).map(item => item.user),
            level2: referralNetwork.filter(item => item.level === 2).map(item => item.user),
            level3: referralNetwork.filter(item => item.level === 3).map(item => item.user)
        };

        const referralCounts = {
            level1: organizedReferrals.level1.length,
            level2: organizedReferrals.level2.length,
            level3: organizedReferrals.level3.length,
            total: organizedReferrals.level1.length + organizedReferrals.level2.length + organizedReferrals.level3.length
        };

        const userProfile = {
            user_info: {
                ...user,
                inviter: inviterInfo
            },
            referral_network: {
                levels: organizedReferrals,
                counts: referralCounts
            },
            statistics: {
                total_balance: user.saldo,
                total_referrals: referralCounts.total,
                registration_date: user.created_at,
                account_age_days: Math.floor((new Date() - new Date(user.created_at)) / (1000 * 60 * 60 * 24))
            }
        };

        res.json({
            success: true,
            message: 'Perfil completo obtido com sucesso',
            data: userProfile
        });

    } catch (error) {
        console.error('Erro ao buscar perfil completo:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para obter rede de indicação (protegida)
app.get('/user/:id/referral-network', authenticateToken, authorizeUser, async (req, res) => {
    try {
        const userId = req.params.id;
        
        const level1Referrals = await prisma.user.findMany({
            where: { inviter_id: userId },
            select: {
                id: true,
                mobile: true,
                saldo: true,
                invitation_code: true,
                created_at: true
            }
        });

        const level2Users = await prisma.user.findMany({
            where: {
                inviter_id: {
                    in: level1Referrals.map(user => user.id)
                }
            },
            select: {
                id: true,
                mobile: true,
                saldo: true,
                invitation_code: true,
                created_at: true,
                inviter_id: true
            }
        });

        const level3Users = await prisma.user.findMany({
            where: {
                inviter_id: {
                    in: level2Users.map(user => user.id)
                }
            },
            select: {
                id: true,
                mobile: true,
                saldo: true,
                invitation_code: true,
                created_at: true
            }
        });

        res.json({
            success: true,
            data: {
                level1: level1Referrals,
                level2: level2Users,
                level3: level3Users,
                total: level1Referrals.length + level2Users.length + level3Users.length
            }
        });

    } catch (error) {
        console.error('Erro ao buscar rede de indicação:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para listar todos os convidados (protegida)
app.get('/user/:id/all-referrals', authenticateToken, authorizeUser, async (req, res) => {
    try {
        const userId = req.params.id;
        
        const network = await prisma.referralLevel.findMany({
            where: {
                referrer_id: userId
            },
            include: {
                user: {
                    select: {
                        id: true,
                        mobile: true,
                        saldo: true,
                        invitation_code: true,
                        created_at: true
                    }
                }
            },
            orderBy: {
                level: 'asc'
            }
        });

        const organizedData = {
            level1: network.filter(item => item.level === 1).map(item => item.user),
            level2: network.filter(item => item.level === 2).map(item => item.user),
            level3: network.filter(item => item.level === 3).map(item => item.user)
        };

        res.json({
            success: true,
            data: organizedData
        });

    } catch (error) {
        console.error('Erro ao buscar todos os convidados:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para atualizar usuário (protegida)
app.put('/user/:id', authenticateToken, authorizeUser, async (req, res) => {
    try {
        const userId = req.params.id;
        const { mobile, password, pay_password } = req.body;
        
        const updateData = { updated_at: new Date() };
        
        if (mobile) updateData.mobile = mobile;
        if (password) updateData.password = await bcrypt.hash(password, 10);
        if (pay_password) updateData.pay_password = await bcrypt.hash(pay_password, 10);

        const updatedUser = await prisma.user.update({
            where: { id: userId },
            data: updateData,
            select: {
                id: true,
                mobile: true,
                saldo: true,
                invitation_code: true,
                updated_at: true
            }
        });

        res.json({
            success: true,
            message: 'Usuário atualizado com sucesso',
            data: updatedUser
        });

    } catch (error) {
        console.error('Erro ao atualizar usuário:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para deletar usuário (protegida - cuidado com essa rota!)
app.delete('/user/:id', authenticateToken, authorizeUser, async (req, res) => {
    try {
        const userId = req.params.id;
        
        await prisma.user.delete({
            where: { id: userId }
        });

        res.json({
            success: true,
            message: 'Usuário deletado com sucesso'
        });

    } catch (error) {
        console.error('Erro ao deletar usuário:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Iniciar servidor
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    
    prisma.$connect()
        .then(() => console.log('Conectado ao banco de dados'))
        .catch(err => console.error('Erro na conexão com o banco:', err));
});

// Graceful shutdown
process.on('SIGINT', async () => {
    await prisma.$disconnect();
    process.exit(0);
});