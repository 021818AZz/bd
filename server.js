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
        select: { id: true } // Apenas seleciona o ID para ser mais rápido
    });

    if (existingCode) {
        return generateUniqueInvitationCode(attempts + 1);
    }

    return invitationCode;
}

// Rota de registro OTIMIZADA
app.post('/register', async (req, res) => {
    const startTime = Date.now();
    
    try {
        const { mobile, password, pay_password, invitation_code } = req.body;
        
        // Validações básicas rápidas
        if (!mobile || !password || !pay_password) {
            return res.status(400).json({
                success: false,
                message: 'Telefone, senha e senha de pagamento são obrigatórios'
            });
        }

        // Verificar se o usuário já existe (mais rápido)
        const existingUser = await prisma.user.findUnique({
            where: { mobile },
            select: { id: true } // Apenas o ID para ser mais rápido
        });

        if (existingUser) {
            return res.status(400).json({
                success: false,
                message: 'Número de telefone já cadastrado'
            });
        }

        // Processar em paralelo para melhor performance
        const [hashedPassword, hashedPayPassword, invitationCode, inviter] = await Promise.all([
            bcrypt.hash(password, 10),
            bcrypt.hash(pay_password, 10),
            generateUniqueInvitationCode(),
            invitation_code ? prisma.user.findFirst({
                where: { invitation_code: invitation_code },
                select: { id: true } // Apenas o ID
            }) : Promise.resolve(null)
        ]);

        // Criar usuário
        const newUser = await prisma.user.create({
            data: {
                mobile,
                password: hashedPassword,
                pay_password: hashedPayPassword,
                invitation_code: invitationCode,
                inviter_id: inviter?.id || null,
                created_at: new Date(),
                updated_at: new Date()
            },
            select: {
                id: true,
                mobile: true,
                invitation_code: true
            }
        });

        // Gerar token JWT (assíncrono mas não bloqueante)
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
                    mobile: newUser.mobile
                },
                token
            }
        });

    } catch (error) {
        console.error('Erro no registro:', error);
        
        // Erros específicos
        if (error.code === 'P2002') { // Erro de unique constraint do Prisma
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

// Rota de login rápida (se precisar)
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
            select: { id: true, password: true, mobile: true }
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
                    mobile: user.mobile
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

// Rota simples para testar o Prisma
app.get('/test-db', async (req, res) => {
    try {
        const users = await prisma.user.findMany({
            take: 5, // Limita a 5 resultados
            select: { id: true, mobile: true } // Apenas campos necessários
        });
        res.json({ success: true, users });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Iniciar servidor com otimizações
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    
    // Testar conexão com banco
    prisma.$connect()
        .then(() => console.log('Conectado ao banco de dados'))
        .catch(err => console.error('Erro na conexão com o banco:', err));
});

// Graceful shutdown
process.on('SIGINT', async () => {
    await prisma.$disconnect();
    process.exit(0);
});