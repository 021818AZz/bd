const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const app = express();
const PORT = 3000;

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

// Health check otimizado
app.get('/health', async (req, res) => {
    res.status(200).json({ 
        success: true, 
        message: 'Servidor está funcionando',
        timestamp: new Date().toISOString()
    });
});

// Função otimizada para gerar código de convite único
async function generateUniqueInvitationCode(attempts = 0) {
    if (attempts > 5) {
        throw new Error('Não foi possível gerar um código único após várias tentativas');
    }

    const invitationCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    
    const existingCode = await prisma.user.findFirst({
        where: { invitation_code: invitationCode },
        select: { id: true }
    });

    if (existingCode) {
        return generateUniqueInvitationCode(attempts + 1);
    }

    return invitationCode;
}

// Função para encontrar todos os níveis de indicação
async function findReferralLevels(inviterId, levels = [], currentLevel = 1) {
    if (currentLevel > 3 || !inviterId) return levels;
    
    const inviter = await prisma.user.findUnique({
        where: { id: inviterId },
        select: { id: true, mobile: true, invitation_code: true, inviter_id: true }
    });
    
    if (inviter) {
        levels.push({
            level: currentLevel,
            user_id: inviter.id,
            mobile: inviter.mobile,
            invitation_code: inviter.invitation_code
        });
        
        // Buscar próximo nível
        if (inviter.inviter_id) {
            return findReferralLevels(inviter.inviter_id, levels, currentLevel + 1);
        }
    }
    
    return levels;
}

// Rota de registro OTIMIZADA
app.post('/register', async (req, res) => {
    const startTime = Date.now();
    
    try {
        const { mobile, password, pay_password, invitation_code } = req.body;
        
        // Validações básicas
        if (!mobile || !password || !pay_password) {
            return res.status(400).json({
                success: false,
                message: 'Telefone, senha e senha de pagamento são obrigatórios'
            });
        }

        // Verificar se o usuário já existe
        const existingUser = await prisma.user.findUnique({
            where: { mobile },
            select: { id: true }
        });

        if (existingUser) {
            return res.status(400).json({
                success: false,
                message: 'Número de telefone já cadastrado'
            });
        }

        let inviterId = null;
        let referralLevels = [];

        // Processar código de convite se fornecido
        if (invitation_code) {
            const inviter = await prisma.user.findFirst({
                where: { invitation_code: invitation_code },
                select: { id: true }
            });
            
            if (inviter) {
                inviterId = inviter.id;
                
                // Encontrar todos os níveis de indicação
                referralLevels = await findReferralLevels(inviterId);
            } else {
                return res.status(400).json({
                    success: false,
                    message: 'Código de convite inválido'
                });
            }
        }

        // Processar em paralelo para melhor performance
        const [hashedPassword, hashedPayPassword, invitationCode] = await Promise.all([
            bcrypt.hash(password, 10),
            bcrypt.hash(pay_password, 10),
            generateUniqueInvitationCode()
        ]);

        // Criar usuário
        const newUser = await prisma.user.create({
            data: {
                mobile,
                password: hashedPassword,
                pay_password: hashedPayPassword,
                invitation_code: invitationCode,
                inviter_id: inviterId,
                created_at: new Date(),
                updated_at: new Date()
            },
            select: {
                id: true,
                mobile: true,
                invitation_code: true,
                inviter_id: true
            }
        });

        // Criar registros de referral levels se houver indicação
        if (referralLevels.length > 0) {
            await Promise.all(
                referralLevels.map(level => 
                    prisma.referralLevel.create({
                        data: {
                            user_id: newUser.id,
                            referrer_id: level.user_id,
                            level: level.level,
                            created_at: new Date()
                        }
                    })
                )
            );
        }

        // Gerar token JWT
        const token = jwt.sign(
            { userId: newUser.id }, 
            process.env.JWT_SECRET || 'seu_segredo_jwt', 
            { expiresIn: '24h' }
        );

        const endTime = Date.now();
        console.log(`Tempo de registro: ${endTime - startTime}ms`);

        res.status(201).json({
            success: true,
            message: 'Usuário cadastrado com sucesso',
            data: {
                user: {
                    id: newUser.id,
                    mobile: newUser.mobile,
                    invitation_code: newUser.invitation_code
                },
                referral_levels: referralLevels,
                token
            }
        });

    } catch (error) {
        console.error('Erro no registro:', error);
        
        if (error.code === 'P2002') {
            return res.status(400).json({
                success: false,
                message: 'Número de telefone já cadastrado'
            });
        }

        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para obter rede de indicação
app.get('/user/:id/referral-network', async (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        
        // Buscar nível 1 (indicados diretos)
        const level1Referrals = await prisma.user.findMany({
            where: { inviter_id: userId },
            select: {
                id: true,
                mobile: true,
                invitation_code: true,
                created_at: true
            }
        });

        // Buscar nível 2 (indicados dos indicados)
        const level2Users = await prisma.user.findMany({
            where: {
                inviter_id: {
                    in: level1Referrals.map(user => user.id)
                }
            },
            select: {
                id: true,
                mobile: true,
                invitation_code: true,
                created_at: true,
                inviter_id: true
            }
        });

        // Buscar nível 3
        const level3Users = await prisma.user.findMany({
            where: {
                inviter_id: {
                    in: level2Users.map(user => user.id)
                }
            },
            select: {
                id: true,
                mobile: true,
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

// Rota para listar todos os convidados de um usuário (níveis 1, 2 e 3)
app.get('/user/:id/all-referrals', async (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        
        // Buscar todos os níveis
        const network = await prisma.referralLevel.findMany({
            where: {
                referrer_id: userId
            },
            include: {
                user: {
                    select: {
                        id: true,
                        mobile: true,
                        invitation_code: true,
                        created_at: true
                    }
                }
            },
            orderBy: {
                level: 'asc'
            }
        });

        // Organizar por nível
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

// Rota de login
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
            select: { id: true, password: true, mobile: true, invitation_code: true }
        });

        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({
                success: false,
                message: 'Credenciais inválidas'
            });
        }

        const token = jwt.sign(
            { userId: user.id }, 
            process.env.JWT_SECRET || 'seu_segredo_jwt', 
            { expiresIn: '24h' }
        );

        res.json({
            success: true,
            message: 'Login realizado com sucesso',
            data: {
                user: {
                    id: user.id,
                    mobile: user.mobile,
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

// Rota para verificar código de convite
app.get('/invitation/:code/verify', async (req, res) => {
    try {
        const { code } = req.params;
        
        const user = await prisma.user.findFirst({
            where: { invitation_code: code },
            select: { id: true, mobile: true }
        });

        if (user) {
            res.json({
                success: true,
                valid: true,
                user: {
                    id: user.id,
                    mobile: user.mobile
                }
            });
        } else {
            res.json({
                success: true,
                valid: false,
                message: 'Código de convite inválido'
            });
        }

    } catch (error) {
        console.error('Erro ao verificar código:', error);
        res.status(500).json({
            success: false,
            message: 'Erro interno do servidor'
        });
    }
});

// Rota para obter informações do usuário
app.get('/user/:id', async (req, res) => {
    try {
        const userId = parseInt(req.params.id);
        
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                mobile: true,
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